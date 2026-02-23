import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { MatchingGateway } from './matching.gateway';

interface NearbyCaregiver {
    id: string;
    userId: string;
    email: string;
    name: string;
    distance: number; // km
    specialties: string[];
    rating: number;
}

@Injectable()
export class MatchingService {
    private readonly logger = new Logger(MatchingService.name);

    constructor(
        private prisma: PrismaService,
        private mailService: MailService,
        private matchingGateway: MatchingGateway,
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
     * Find caregivers near a service location
     */
    async findNearbyCaregivers(
        serviceLat: number,
        serviceLng: number,
        serviceType?: string,
    ): Promise<NearbyCaregiver[]> {
        // Get all available + verified caregivers with location
        const caregivers = await this.prisma.caregiver.findMany({
            where: {
                isAvailable: true,
                verificationStatus: 'verified',
                locationLat: { not: null },
                locationLng: { not: null },
            },
            include: {
                user: { select: { email: true, firstName: true, lastName: true, name: true } },
            },
        });

        const nearby: NearbyCaregiver[] = [];

        for (const cg of caregivers) {
            if (cg.locationLat == null || cg.locationLng == null) continue;

            const distanceKm = this.haversineDistance(
                serviceLat, serviceLng,
                cg.locationLat, cg.locationLng,
            );

            // serviceRadius is in meters, convert to km
            const radiusKm = (cg.serviceRadius || 30000) / 1000;

            if (distanceKm <= radiusKm) {
                // Optional: filter by specialty match
                if (serviceType && cg.specialties.length > 0) {
                    if (!cg.specialties.includes(serviceType)) continue;
                }

                nearby.push({
                    id: cg.id,
                    userId: cg.userId,
                    email: cg.user.email,
                    name: cg.user.name || `${cg.user.firstName || ''} ${cg.user.lastName || ''}`.trim() || 'Cuidador',
                    distance: Math.round(distanceKm * 10) / 10, // 1 decimal
                    specialties: cg.specialties,
                    rating: cg.rating,
                });
            }
        }

        // Sort by distance (nearest first)
        nearby.sort((a, b) => a.distance - b.distance);

        this.logger.log(`Found ${nearby.length} nearby caregivers for location (${serviceLat}, ${serviceLng})`);
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

        if (service.locationLat == null || service.locationLng == null) {
            this.logger.warn(`Service ${serviceId} has no location`);
            return { notified: 0 };
        }

        const nearbyCaregivers = await this.findNearbyCaregivers(
            service.locationLat,
            service.locationLng,
            service.serviceType,
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

            // Email notification (always for offline, also for online as backup)
            if (!isOnline) {
                try {
                    await this.mailService.sendServiceNearbyEmail(
                        cg.email,
                        cg.name,
                        {
                            serviceType: serviceTypeName,
                            patientName: service.patientName || 'No especificado',
                            distance: cg.distance,
                            scheduledDate: service.scheduledDate,
                            serviceId: service.id,
                        },
                    );
                    notifiedVia = isOnline ? 'both' : 'email';
                } catch (err) {
                    this.logger.error(`Failed to email caregiver ${cg.email}`, err);
                }
            }

            // Create notification record
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
