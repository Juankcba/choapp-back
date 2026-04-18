import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { MatchingGateway } from './matching.gateway';
import { UsersService } from '../users/users.service';
import { QueueService } from '../queue/queue.service';
import { isActiveCaregiver } from '../common/activation';

// Fixed system-wide matching radius. Caregivers whose stored location is within
// this distance from the service location are notified. `Caregiver.serviceRadius`
// is currently ignored by the matching algorithm.
export const SERVICE_RADIUS_KM = 30;

// Para servicios virtuales el matching ignora la distancia; `distance` queda
// en null tanto en la lista de nearby como en la ServiceNotification.
interface NearbyCaregiver {
    id: string;
    userId: string;
    email: string;
    name: string;
    distance: number | null; // km, o null si el servicio es virtual
    specialties: string[];
    rating: number;
}

export interface MatchCriteria {
    modality?: 'in_person' | 'virtual';
    // Especialidad declarada buscada (ver common/specialties.ts). Si el service
    // tiene specialty seteado, se filtra por eso. Si no, se usa serviceType
    // como antes — pero para virtual siempre debería venir specialty.
    specialty?: string;
    serviceType?: string;
}

@Injectable()
export class MatchingService {
    private readonly logger = new Logger(MatchingService.name);

    constructor(
        private prisma: PrismaService,
        private mailService: MailService,
        private matchingGateway: MatchingGateway,
        private usersService: UsersService,
        private queueService: QueueService,
    ) { }

    /**
     * Haversine formula: calculate distance between two lat/lng points in km
     */
    private haversineDistance(
        lat1: number, lng1: number,
        lat2: number, lng2: number,
    ): number {
        const R = 6371; // Earth radius in km
        const dLat = this.toRad(lat2 - lat1);
        const dLng = this.toRad(lng2 - lng1);
        const a =
            Math.sin(dLat / 2) ** 2 +
            Math.cos(this.toRad(lat1)) * Math.cos(this.toRad(lat2)) *
            Math.sin(dLng / 2) ** 2;
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }

    private toRad(deg: number): number {
        return deg * (Math.PI / 180);
    }

    /**
     * Find candidate caregivers for a service.
     *
     * - `in_person` (default): aplica filtro Haversine contra el radio fijo
     *   `SERVICE_RADIUS_KM`. Cuidadores sin `locationLat/Lng` quedan fuera.
     * - `virtual`: no aplica filtro geográfico. `serviceLat/Lng` se aceptan
     *   pero se ignoran — el caller puede pasar (0, 0) o los del familiar sin
     *   que afecte al resultado.
     *
     * `criteria.specialty` tiene prioridad sobre `criteria.serviceType` a la
     * hora de filtrar por especialidad. Si ninguno viene, no se filtra por
     * especialidad. Cuidadores con `specialties = []` siempre pasan el filtro
     * (no declaran especialidad → no excluir).
     *
     * Overloads: la firma `(lat, lng, serviceType?)` queda por retrocompat con
     * callers que sólo pasan string.
     */
    findNearbyCaregivers(
        serviceLat: number,
        serviceLng: number,
        serviceType?: string,
    ): Promise<NearbyCaregiver[]>;
    findNearbyCaregivers(
        serviceLat: number,
        serviceLng: number,
        criteria: MatchCriteria,
    ): Promise<NearbyCaregiver[]>;
    async findNearbyCaregivers(
        serviceLat: number,
        serviceLng: number,
        criteriaOrServiceType?: string | MatchCriteria,
    ): Promise<NearbyCaregiver[]> {
        const criteria: MatchCriteria =
            typeof criteriaOrServiceType === 'string'
                ? { serviceType: criteriaOrServiceType }
                : (criteriaOrServiceType ?? {});

        const isVirtual = criteria.modality === 'virtual';
        // Filtro de especialidad efectivo: specialty (explícito) > serviceType (legacy).
        const specialtyFilter = criteria.specialty ?? criteria.serviceType;

        // Active + available caregivers. Para presencial exigimos coords; para
        // virtual no hace falta, pero igual pedimos activación + disponibilidad.
        const caregivers = await this.prisma.caregiver.findMany({
            where: {
                isAvailable: true,
                OR: [
                    { activationStatus: 'active' },
                    { AND: [{ activationStatus: 'pending' }, { verificationStatus: 'verified' }] },
                ],
                ...(isVirtual
                    ? {}
                    : {
                        locationLat: { not: null },
                        locationLng: { not: null },
                    }),
            },
            include: {
                user: { select: { email: true, firstName: true, lastName: true, name: true } },
            },
        });

        const nearby: NearbyCaregiver[] = [];

        for (const cg of caregivers) {
            let distanceKm: number | null = null;

            if (!isVirtual) {
                if (cg.locationLat == null || cg.locationLng == null) continue;

                distanceKm = this.haversineDistance(
                    serviceLat, serviceLng,
                    cg.locationLat, cg.locationLng,
                );

                if (distanceKm > SERVICE_RADIUS_KM) continue;
            }

            // Filtro de especialidad: si hay filtro Y el cuidador declara
            // especialidades, tiene que incluir la buscada. Si no declara
            // ninguna, pasa (no lo excluimos por silencio).
            if (specialtyFilter && cg.specialties.length > 0) {
                if (!cg.specialties.includes(specialtyFilter)) continue;
            }

            nearby.push({
                id: cg.id,
                userId: cg.userId,
                email: cg.user.email,
                name: cg.user.name || `${cg.user.firstName || ''} ${cg.user.lastName || ''}`.trim() || 'Cuidador',
                distance: distanceKm == null ? null : Math.round(distanceKm * 10) / 10,
                specialties: cg.specialties,
                rating: cg.rating,
            });
        }

        // Orden: presencial por distancia asc, virtual por rating desc.
        if (isVirtual) {
            nearby.sort((a, b) => b.rating - a.rating);
        } else {
            nearby.sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0));
        }

        this.logger.log(
            `Found ${nearby.length} candidates (modality=${isVirtual ? 'virtual' : 'in_person'}, specialty=${specialtyFilter ?? '—'})`,
        );
        return nearby;
    }

    /**
     * Main matching flow: find caregivers, notify them, create records
     */
    async notifyNearbyCaregivers(serviceId: string): Promise<{ notified: number }> {
        const service = await this.prisma.service.findUnique({
            where: { id: serviceId },
            include: {
                family: {
                    include: { user: { select: { firstName: true, lastName: true, name: true } } },
                },
            },
        });

        if (!service) {
            this.logger.warn(`Service ${serviceId} not found`);
            return { notified: 0 };
        }

        const isVirtual = service.modality === 'virtual';

        // Presencial requiere coordenadas para poder filtrar por radio.
        // Virtual no — las coordenadas son opcionales.
        if (!isVirtual && (service.locationLat == null || service.locationLng == null)) {
            this.logger.warn(`Service ${serviceId} (in_person) has no location`);
            return { notified: 0 };
        }

        const nearbyCaregivers = await this.findNearbyCaregivers(
            service.locationLat ?? 0,
            service.locationLng ?? 0,
            {
                modality: isVirtual ? 'virtual' : 'in_person',
                specialty: service.specialty ?? undefined,
                serviceType: service.serviceType,
            },
        );

        if (nearbyCaregivers.length === 0) {
            this.logger.log(`No nearby caregivers found for service ${serviceId}`);
            return { notified: 0 };
        }

        const serviceTypeName = this.getServiceTypeName(service.serviceType);
        const familyName = service.family.user.name ||
            `${service.family.user.firstName || ''} ${service.family.user.lastName || ''}`.trim() || 'Familia';

        let notifiedCount = 0;

        for (const cg of nearbyCaregivers) {
            // Skip if already notified (prevents duplicates from cron re-runs)
            const existing = await this.prisma.serviceNotification.findFirst({
                where: { serviceId: service.id, caregiverId: cg.id },
            });
            if (existing) {
                // If caregiver is now online and notification is still pending, re-emit WebSocket
                if (existing.status === 'pending' && this.matchingGateway.isOnline(cg.userId)) {
                    this.matchingGateway.emitToCaregiver(cg.userId, 'new-service-nearby', {
                        serviceId: service.id,
                        serviceType: serviceTypeName,
                        patientName: service.patientName || 'No especificado',
                        familyName,
                        distance: cg.distance,
                        scheduledDate: service.scheduledDate,
                        duration: service.duration,
                    });
                }
                continue;
            }

            const isOnline = this.matchingGateway.isOnline(cg.userId);
            let notifiedVia = 'email';

            const notificationPayload = {
                serviceId: service.id,
                serviceType: serviceTypeName,
                patientName: service.patientName || 'No especificado',
                familyName,
                distance: cg.distance,
                scheduledDate: service.scheduledDate,
                duration: service.duration,
            };

            // WebSocket notification for online caregivers
            if (isOnline) {
                this.matchingGateway.emitToCaregiver(cg.userId, 'new-service-nearby', notificationPayload);
                notifiedVia = 'websocket';
            }

            // Push notification (always — works when app is closed). Enqueued
            // so a transient FCM outage retries in the background.
            const pushTitle = isVirtual ? '🔔 Nuevo servicio virtual' : '🔔 Nuevo servicio cerca';
            const pushBody = isVirtual
                ? serviceTypeName
                : `${serviceTypeName} - ${(cg.distance ?? 0).toFixed(1)} km`;
            this.queueService.enqueuePush(
                cg.userId,
                pushTitle,
                pushBody,
                { type: 'new-service-nearby', serviceId: service.id },
            ).catch(e => this.logger.error('Enqueue push failed for caregiver', e));

            // Email notification (always for offline, also for online as backup)
            if (!isOnline) {
                try {
                    await this.mailService.sendServiceNearbyEmail(
                        cg.email,
                        cg.name,
                        {
                            serviceType: serviceTypeName,
                            patientName: service.patientName || 'No especificado',
                            // Para virtual pasamos 0 — el template igual ignora la
                            // distancia cuando el servicio no es local. Si en
                            // algún momento el mail se diferencia por modalidad,
                            // extender el DTO del MailService.
                            distance: cg.distance ?? 0,
                            scheduledDate: service.scheduledDate,
                            serviceId: service.id,
                        },
                    );
                    notifiedVia = isOnline ? 'both' : 'email';
                } catch (err) {
                    this.logger.error(`Failed to email caregiver ${cg.email}`, err);
                }
            }

            // Create notification record. `distance` es nullable en schema:
            // queda null cuando el servicio es virtual.
            await this.prisma.serviceNotification.create({
                data: {
                    serviceId: service.id,
                    caregiverId: cg.id,
                    distance: cg.distance,
                    notifiedVia,
                },
            });

            notifiedCount++;
        }

        this.logger.log(`Notified ${notifiedCount} caregivers for service ${serviceId}`);
        return { notified: notifiedCount };
    }

    /**
     * Caregiver expresses interest in a service (does NOT assign them)
     */
    async respondToService(caregiverId: string, serviceId: string, interested: boolean) {
        const notification = await this.prisma.serviceNotification.findFirst({
            where: { serviceId, caregiverId },
        });

        if (!notification) {
            throw new Error('Notification not found');
        }

        await this.prisma.serviceNotification.update({
            where: { id: notification.id },
            data: {
                status: interested ? 'interested' : 'declined',
                respondedAt: new Date(),
            },
        });

        if (interested) {
            // Move service to 'matched' if not already
            const service = await this.prisma.service.findUnique({
                where: { id: serviceId },
                include: {
                    family: { include: { user: { select: { id: true, email: true, firstName: true, name: true } } } },
                },
            });

            if (service && service.status === 'pending') {
                await this.prisma.service.update({
                    where: { id: serviceId },
                    data: { status: 'matched' },
                });
            }

            // Get caregiver info for family notification
            const caregiver = await this.prisma.caregiver.findUnique({
                where: { id: caregiverId },
                include: { user: { select: { firstName: true, lastName: true, name: true } } },
            });

            // Notify family via WebSocket
            if (service?.family?.user) {
                const familyUserId = service.family.user.id;
                const serviceTypeName = this.getServiceTypeName(service.serviceType);
                const caregiverName = caregiver?.user?.name ||
                    `${caregiver?.user?.firstName || ''} ${caregiver?.user?.lastName || ''}`.trim() || 'Un cuidador';

                this.matchingGateway.emitToUser(familyUserId, 'caregiver-interested', {
                    serviceId,
                    serviceType: serviceTypeName,
                    caregiverName,
                    caregiverId,
                });

                // Email family about interested caregiver
                if (service.family.user.email) {
                    const familyName = service.family.user.name || service.family.user.firstName || 'Familia';
                    this.mailService.sendCaregiverInterestedEmail(
                        service.family.user.email, familyName,
                        { caregiverName, serviceType: serviceTypeName, serviceId },
                    ).catch(e => this.logger.error('Failed to send caregiver interested email', e));
                }

                this.logger.log(`Notified family ${familyUserId} about interested caregiver ${caregiverId}`);

                // Push notification to family
                this.queueService.enqueuePush(
                    familyUserId,
                    '💜 Cuidador interesado',
                    `${caregiverName} quiere cuidar a tu familiar`,
                    { type: 'caregiver-interested', serviceId },
                ).catch(e => this.logger.error('Enqueue push failed for family', e));
            }
            this.logger.log(`Caregiver ${caregiverId} interested in service ${serviceId}`);
        } else {
            this.logger.log(`Caregiver ${caregiverId} declined service ${serviceId}`);
        }

        return { status: interested ? 'interested' : 'declined' };
    }

    /**
     * Family selects a caregiver from the interested candidates
     */
    async selectCaregiver(serviceId: string, caregiverId: string) {
        // Assign caregiver to service
        await this.prisma.service.update({
            where: { id: serviceId },
            data: {
                caregiverId,
                status: 'accepted',
            },
        });

        // Mark selected notification as accepted
        await this.prisma.serviceNotification.updateMany({
            where: { serviceId, caregiverId },
            data: { status: 'accepted', respondedAt: new Date() },
        });

        // Get declined caregivers BEFORE updating them (so we can notify them)
        const declinedNotifications = await this.prisma.serviceNotification.findMany({
            where: { serviceId, caregiverId: { not: caregiverId }, status: 'interested' },
            include: { caregiver: { select: { userId: true } } },
        });

        // Mark all other interested notifications as declined
        await this.prisma.serviceNotification.updateMany({
            where: { serviceId, caregiverId: { not: caregiverId }, status: 'interested' },
            data: { status: 'declined', respondedAt: new Date() },
        });

        // Notify selected caregiver via WebSocket + Email
        const caregiver = await this.prisma.caregiver.findUnique({
            where: { id: caregiverId },
            include: { user: { select: { email: true, firstName: true, lastName: true, name: true } } },
        });
        const service = await this.prisma.service.findUnique({
            where: { id: serviceId },
            include: { family: { include: { user: { select: { firstName: true, lastName: true, name: true } } } } },
        });

        if (caregiver) {
            this.matchingGateway.emitToUser(caregiver.userId, 'service-confirmed', { serviceId });

            // Email caregiver about selection
            if (caregiver.user?.email) {
                const caregiverName = caregiver.user.name || caregiver.user.firstName || 'Cuidador';
                const familyName = service?.family?.user?.name ||
                    `${service?.family?.user?.firstName || ''} ${service?.family?.user?.lastName || ''}`.trim() || 'Familia';
                this.mailService.sendCaregiverSelectedEmail(
                    caregiver.user.email, caregiverName,
                    {
                        familyName,
                        serviceType: this.getServiceTypeName(service?.serviceType || ''),
                        patientName: service?.patientName || 'paciente',
                        serviceId,
                    },
                ).catch(e => this.logger.error('Failed to send caregiver selected email', e));
            }

            // Push notification to confirmed caregiver
            this.queueService.enqueuePush(
                caregiver.userId,
                '🎉 ¡Te seleccionaron!',
                'Una familia te eligió para un servicio',
                { type: 'service-confirmed', serviceId },
            ).catch(e => this.logger.error('Enqueue push failed for confirmed caregiver', e));
        }

        // Notify declined caregivers via WebSocket
        for (const declined of declinedNotifications) {
            this.matchingGateway.emitToUser(declined.caregiver.userId, 'service-declined', { serviceId });
            // Push notification to declined caregivers
            this.queueService.enqueuePush(
                declined.caregiver.userId,
                'Servicio asignado',
                'La familia eligió a otro cuidador para este servicio',
                { type: 'service-declined', serviceId },
            ).catch(e => this.logger.error('Enqueue push failed for declined caregiver', e));
            this.logger.log(`Notified declined caregiver ${declined.caregiverId} for service ${serviceId}`);
        }

        this.logger.log(`Family selected caregiver ${caregiverId} for service ${serviceId}`);
        return { status: 'accepted' };
    }

    private getServiceTypeName(type: string): string {
        const types: Record<string, string> = {
            elderly_care: 'Cuidado de Ancianos',
            special_needs: 'Necesidades Especiales',
            alzheimers: 'Alzheimer y Demencia',
            physical_therapy: 'Terapia Física',
            medication_management: 'Administración de Medicamentos',
            companionship: 'Compañía',
            personal_care: 'Cuidado Personal',
            dementia_care: 'Cuidado de Demencia',
        };
        return types[type] || type;
    }
}
