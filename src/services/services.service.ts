import { Injectable, NotFoundException, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MatchingService } from '../matching/matching.service';
import { MatchingGateway } from '../matching/matching.gateway';
import { MailService } from '../mail/mail.service';
import { UsersService } from '../users/users.service';
import { QueueService } from '../queue/queue.service';
import { VideoSessionsService } from '../video-sessions/video-sessions.service';
import { isSpecialty, VIRTUAL_FRIENDLY_SPECIALTIES } from '../common/specialties';

@Injectable()
export class ServicesService {
    private readonly logger = new Logger(ServicesService.name);

    constructor(
        private prisma: PrismaService,
        private matchingService: MatchingService,
        private matchingGateway: MatchingGateway,
        private mailService: MailService,
        private usersService: UsersService,
        private queueService: QueueService,
        private videoSessionsService: VideoSessionsService,
    ) { }

    async create(userId: string, data: any) {
        const family = await this.prisma.family.findUnique({ where: { userId } });
        if (!family) throw new NotFoundException('Family profile not found');

        const modality = data.modality === 'virtual' ? 'virtual' : 'in_person';

        // Validar payload específico de virtual si corresponde.
        if (modality === 'virtual') {
            if (!data.specialty || !isSpecialty(data.specialty)) {
                throw new BadRequestException(
                    'Un servicio virtual requiere una especialidad válida (ver catálogo)',
                );
            }
            // La especialidad debe poder darse por videollamada. Prácticas que
            // requieren contacto físico (administrar medicación, cuidado de
            // adultos mayores, postoperatorio, etc.) quedan fuera del MVP de
            // acompañamiento digital.
            if (!(VIRTUAL_FRIENDLY_SPECIALTIES as readonly string[]).includes(data.specialty)) {
                throw new BadRequestException(
                    `La especialidad "${data.specialty}" no se puede prestar de forma virtual`,
                );
            }
            if (!data.sessionsPerWeek || data.sessionsPerWeek < 1) {
                throw new BadRequestException('sessionsPerWeek requerido para servicios virtuales');
            }
            if (!Array.isArray(data.preferredSlots) || data.preferredSlots.length === 0) {
                throw new BadRequestException(
                    'preferredSlots requerido para servicios virtuales (al menos un slot semanal)',
                );
            }
            for (const slot of data.preferredSlots) {
                if (
                    typeof slot?.dayOfWeek !== 'number' || slot.dayOfWeek < 0 || slot.dayOfWeek > 6 ||
                    typeof slot?.startTime !== 'string' || !/^\d{2}:\d{2}$/.test(slot.startTime) ||
                    typeof slot?.durationMin !== 'number' || slot.durationMin < 15 || slot.durationMin > 240
                ) {
                    throw new BadRequestException('preferredSlots mal formado');
                }
            }
        }

        // En virtual, el "tipo de servicio" siempre es 'digital' — la variedad
        // del paquete la da la especialidad (psicología, nutrición, etc.).
        // Forzamos el valor acá para no depender de que el cliente lo mande bien.
        const serviceType = modality === 'virtual' ? 'digital' : data.serviceType;

        const service = await this.prisma.service.create({
            data: {
                familyId: family.id,
                modality,
                serviceType,
                specialty: data.specialty ?? null,
                sessionsPerWeek: modality === 'virtual' ? data.sessionsPerWeek : null,
                preferredSlots: modality === 'virtual' ? data.preferredSlots : [],
                patientName: data.patientName,
                patientAge: data.patientAge,
                patientCondition: data.patientCondition,
                specialNeeds: data.specialNeeds,
                scheduledDate: data.scheduledDate ? new Date(data.scheduledDate) : null,
                duration: data.duration,
                notes: data.notes,
                // Dirección física: solo tiene sentido en presencial. En virtual
                // dejamos todo null — el matching no los usa y el UI no debería
                // pedirlos.
                serviceAddress: modality === 'virtual' ? null : data.serviceAddress,
                serviceLocationLat: modality === 'virtual' ? null : data.serviceLocationLat,
                serviceLocationLng: modality === 'virtual' ? null : data.serviceLocationLng,
                locationLat: modality === 'virtual'
                    ? null
                    : (data.serviceLocationLat || data.locationLat || family.locationLat),
                locationLng: modality === 'virtual'
                    ? null
                    : (data.serviceLocationLng || data.locationLng || family.locationLng),
            },
        });

        // 🔔 Trigger async matching — find and notify nearby caregivers
        this.matchingService.notifyNearbyCaregivers(service.id)
            .then((result) => {
                this.logger.log(`Matching complete for service ${service.id}: ${result.notified} caregivers notified`);
            })
            .catch((err) => {
                this.logger.error(`Matching failed for service ${service.id}`, err);
            });

        return service;
    }

    async findByFamily(userId: string) {
        const family = await this.prisma.family.findUnique({ where: { userId } });
        if (!family) throw new NotFoundException('Family profile not found');

        return this.prisma.service.findMany({
            where: { familyId: family.id },
            include: {
                caregiver: {
                    include: { user: { select: { firstName: true, lastName: true, image: true } } },
                },
            },
            orderBy: { createdAt: 'desc' },
        });
    }

    /**
     * Get active services for a caregiver (accepted, in_progress, completed)
     */
    async findActiveForCaregiver(userId: string) {
        const caregiver = await this.prisma.caregiver.findUnique({ where: { userId } });
        if (!caregiver) throw new NotFoundException('Caregiver not found');

        return this.prisma.service.findMany({
            where: {
                caregiverId: caregiver.id,
                status: { in: ['accepted', 'in_progress', 'completed'] },
            },
            include: {
                family: {
                    include: { user: { select: { firstName: true, lastName: true, name: true, phone: true } } },
                },
            },
            orderBy: { updatedAt: 'desc' },
        });
    }

    async findById(id: string) {
        const service = await this.prisma.service.findUnique({
            where: { id },
            include: {
                family: {
                    include: { user: { select: { firstName: true, lastName: true, phone: true } } },
                },
                caregiver: {
                    include: { user: { select: { firstName: true, lastName: true, phone: true, image: true } } },
                },
            },
        });
        if (!service) throw new NotFoundException('Service not found');
        return service;
    }

    async update(userId: string, serviceId: string, data: any) {
        const family = await this.prisma.family.findUnique({ where: { userId } });
        if (!family) throw new NotFoundException('Family profile not found');

        const service = await this.prisma.service.findUnique({ where: { id: serviceId } });
        if (!service) throw new NotFoundException('Service not found');
        if (service.familyId !== family.id) throw new NotFoundException('Service not found');
        if (service.status !== 'pending') throw new Error('Only pending services can be edited');

        return this.prisma.service.update({
            where: { id: serviceId },
            data: {
                ...(data.serviceType && { serviceType: data.serviceType }),
                ...(data.patientName && { patientName: data.patientName }),
                ...(data.patientAge != null && { patientAge: data.patientAge }),
                ...(data.patientCondition && { patientCondition: data.patientCondition }),
                ...(data.specialNeeds && { specialNeeds: data.specialNeeds }),
                ...(data.scheduledDate && { scheduledDate: new Date(data.scheduledDate) }),
                ...(data.duration != null && { duration: data.duration }),
                ...(data.notes !== undefined && { notes: data.notes }),
            },
        });
    }

    async remove(userId: string, serviceId: string) {
        const family = await this.prisma.family.findUnique({ where: { userId } });
        if (!family) throw new NotFoundException('Family profile not found');

        const service = await this.prisma.service.findUnique({ where: { id: serviceId } });
        if (!service) throw new NotFoundException('Service not found');
        if (service.familyId !== family.id) throw new NotFoundException('Service not found');

        // Delete all related records first to avoid foreign key constraints
        await this.prisma.serviceNotification.deleteMany({ where: { serviceId } });
        await this.prisma.chat.deleteMany({ where: { serviceId } });
        await this.prisma.review.deleteMany({ where: { serviceId } });

        return this.prisma.service.delete({ where: { id: serviceId } });
    }

    async getInterestedCaregivers(serviceId: string) {
        const notifications = await this.prisma.serviceNotification.findMany({
            where: {
                serviceId,
                status: 'interested',
            },
            include: {
                caregiver: {
                    include: {
                        user: {
                            select: {
                                firstName: true, lastName: true, name: true,
                                image: true, email: true,
                            },
                        },
                    },
                },
            },
            orderBy: { distance: 'asc' },
        });

        return notifications.map((n) => ({
            notificationId: n.id,
            caregiverId: n.caregiverId,
            distance: n.distance,
            respondedAt: n.respondedAt,
            caregiver: {
                id: n.caregiver.id,
                firstName: n.caregiver.user.firstName,
                lastName: n.caregiver.user.lastName,
                name: n.caregiver.user.name,
                image: n.caregiver.user.image,
                rating: n.caregiver.rating,
                totalReviews: n.caregiver.totalReviews,
                experience: n.caregiver.experience,
                hourlyRate: n.caregiver.hourlyRate,
                bio: n.caregiver.bio,
                specialties: n.caregiver.specialties,
                certifications: (n.caregiver.certifications || []) as any[],
                // Esquemas de pago que acepta para servicios virtuales.
                // La familia elige uno al confirmarlo.
                paymentSchemes: n.caregiver.paymentSchemes && n.caregiver.paymentSchemes.length > 0
                    ? n.caregiver.paymentSchemes
                    : ['upfront_full'],
            },
        }));
    }

    async selectCaregiver(
        userId: string,
        serviceId: string,
        caregiverId: string,
        paymentScheme?: string,
    ) {
        const family = await this.prisma.family.findUnique({ where: { userId } });
        if (!family) throw new NotFoundException('Family profile not found');

        const service = await this.prisma.service.findUnique({ where: { id: serviceId } });
        if (!service) throw new NotFoundException('Service not found');
        if (service.familyId !== family.id) throw new NotFoundException('Service not found');
        if (service.status !== 'matched') throw new Error('Service is not in matched state');

        // Para virtuales, el pacto incluye el paymentScheme: qué esquema
        // aceptó la familia entre los que ofrece el cuidador.
        if (service.modality === 'virtual') {
            const caregiver = await this.prisma.caregiver.findUnique({
                where: { id: caregiverId },
                select: { paymentSchemes: true },
            });
            const accepted = (caregiver?.paymentSchemes && caregiver.paymentSchemes.length > 0)
                ? caregiver.paymentSchemes
                : ['upfront_full'];
            // Si la familia no especificó, caemos al primero disponible.
            // En la práctica el frontend solo permite saltearlo si hay uno solo.
            const chosen = paymentScheme && accepted.includes(paymentScheme)
                ? paymentScheme
                : (accepted.includes('upfront_full') ? 'upfront_full' : accepted[0]);

            if (paymentScheme && !accepted.includes(paymentScheme)) {
                throw new BadRequestException(
                    `El cuidador no acepta el esquema de pago "${paymentScheme}"`,
                );
            }

            await this.prisma.service.update({
                where: { id: serviceId },
                data: { paymentScheme: chosen },
            });
        }

        const result = await this.matchingService.selectCaregiver(serviceId, caregiverId);

        // Encadenamiento para servicios virtuales: al aceptar cuidador
        // materializamos el paquete (4 semanas por defecto). Idempotente, si
        // falla no bloqueamos la selección — se puede reintentar manualmente
        // desde el endpoint `/video-sessions/materialize/:serviceId`.
        if (service.modality === 'virtual') {
            this.videoSessionsService.materializeForService(serviceId, { weeks: 4 })
                .then(r => this.logger.log(
                    `Virtual ${serviceId}: ${r.created} sesiones materializadas (${r.skipped} ya existían)`,
                ))
                .catch(err => this.logger.error(
                    `Virtual materialize failed for ${serviceId}`, err,
                ));
        }

        return result;
    }

    async getNotificationsForCaregiver(userId: string) {
        const caregiver = await this.prisma.caregiver.findUnique({ where: { userId } });
        if (!caregiver) throw new NotFoundException('Caregiver not found');

        const notifications = await this.prisma.serviceNotification.findMany({
            where: {
                caregiverId: caregiver.id,
                status: 'pending',
            },
            include: {
                service: {
                    include: {
                        family: {
                            include: { user: { select: { firstName: true, lastName: true, name: true } } },
                        },
                    },
                },
            },
            orderBy: { createdAt: 'desc' },
        });

        return notifications;
    }

    async respondToService(userId: string, serviceId: string, accepted: boolean) {
        const caregiver = await this.prisma.caregiver.findUnique({ where: { userId } });
        if (!caregiver) throw new NotFoundException('Caregiver not found');

        return this.matchingService.respondToService(caregiver.id, serviceId, accepted);
    }

    async getInterestedForCaregiver(userId: string) {
        const caregiver = await this.prisma.caregiver.findUnique({ where: { userId } });
        if (!caregiver) throw new NotFoundException('Caregiver not found');

        const notifications = await this.prisma.serviceNotification.findMany({
            where: {
                caregiverId: caregiver.id,
                status: 'interested',
            },
            include: {
                service: {
                    include: {
                        family: {
                            include: { user: { select: { firstName: true, lastName: true, name: true } } },
                        },
                    },
                },
            },
            orderBy: { respondedAt: 'desc' },
        });

        return notifications;
    }

    async startService(userId: string, serviceId: string) {
        const caregiver = await this.prisma.caregiver.findUnique({ where: { userId } });
        if (!caregiver) throw new NotFoundException('Caregiver not found');

        const service = await this.prisma.service.findUnique({ where: { id: serviceId } });
        if (!service) throw new NotFoundException('Service not found');
        if (service.caregiverId !== caregiver.id) throw new NotFoundException('Not your service');
        if (service.status !== 'accepted') throw new NotFoundException('Service must be accepted to start');

        return this.prisma.service.update({
            where: { id: serviceId },
            data: { status: 'in_progress', actualStart: new Date() },
        });
    }

    async finishService(userId: string, serviceId: string) {
        const caregiver = await this.prisma.caregiver.findUnique({
            where: { userId },
            include: { user: { select: { firstName: true, lastName: true, name: true } } },
        });
        if (!caregiver) throw new NotFoundException('Caregiver not found');

        const service = await this.prisma.service.findUnique({
            where: { id: serviceId },
            include: {
                family: { include: { user: { select: { id: true, email: true, firstName: true, lastName: true, name: true } } } },
            },
        });
        if (!service) throw new NotFoundException('Service not found');
        if (service.caregiverId !== caregiver.id) throw new NotFoundException('Not your service');
        if (service.status !== 'in_progress') throw new NotFoundException('Service must be in progress to finish');

        const updated = await this.prisma.service.update({
            where: { id: serviceId },
            data: { status: 'completed', actualEnd: new Date() },
        });

        // 🔔 Notify family that the service was completed
        const familyUserId = service.family?.user?.id;
        const caregiverName = caregiver.user?.name ||
            `${caregiver.user?.firstName || ''} ${caregiver.user?.lastName || ''}`.trim() || 'El cuidador';
        const serviceTypeName = this.getServiceTypeName(service.serviceType);

        if (familyUserId) {
            // WebSocket notification
            this.matchingGateway.emitToUser(familyUserId, 'service-completed', {
                serviceId,
                serviceType: serviceTypeName,
                caregiverName,
            });

            // Push notification
            this.queueService.enqueuePush(
                familyUserId,
                '✅ Servicio completado',
                `${caregiverName} finalizó el servicio de ${serviceTypeName}`,
                { type: 'service-completed', serviceId },
            ).catch(e => this.logger.error('Enqueue push failed for family (service completed)', e));

            // Email notification
            if (service.family?.user?.email) {
                const familyName = service.family.user.name || service.family.user.firstName || 'Familia';
                this.mailService.sendServiceCompletedEmail(
                    service.family.user.email, familyName,
                    { caregiverName, serviceType: serviceTypeName, serviceId },
                ).catch(e => this.logger.error('Email failed for family (service completed)', e));
            }
        }

        return updated;
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
            digital: 'Acompañamiento digital',
        };
        return types[type] || type;
    }

    /**
     * Stamps `ServiceNotification.readAt` for the caregiver that just opened
     * the service detail (typically after tapping the push). Idempotent — only
     * the first call writes; later opens are a no-op so we keep the first-seen
     * timestamp for engagement metrics.
     */
    async markNotificationRead(userId: string, serviceId: string): Promise<{ updated: boolean }> {
        const caregiver = await this.prisma.caregiver.findUnique({
            where: { userId },
            select: { id: true },
        });
        if (!caregiver) return { updated: false };

        const result = await this.prisma.serviceNotification.updateMany({
            where: {
                serviceId,
                caregiverId: caregiver.id,
                readAt: null,
            },
            data: { readAt: new Date() },
        });

        return { updated: result.count > 0 };
    }
}

