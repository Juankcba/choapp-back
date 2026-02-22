import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MatchingService } from '../matching/matching.service';

@Injectable()
export class ServicesService {
    private readonly logger = new Logger(ServicesService.name);

    constructor(
        private prisma: PrismaService,
        private matchingService: MatchingService,
    ) { }

    async create(userId: string, data: any) {
        const family = await this.prisma.family.findUnique({ where: { userId } });
        if (!family) throw new NotFoundException('Family profile not found');

        const service = await this.prisma.service.create({
            data: {
                familyId: family.id,
                serviceType: data.serviceType,
                patientName: data.patientName,
                patientAge: data.patientAge,
                patientCondition: data.patientCondition,
                specialNeeds: data.specialNeeds,
                scheduledDate: data.scheduledDate ? new Date(data.scheduledDate) : null,
                duration: data.duration,
                paymentMethod: data.paymentMethod,
                amount: data.amount,
                notes: data.notes,
                locationLat: data.locationLat || family.locationLat,
                locationLng: data.locationLng || family.locationLng,
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

        // Delete related notifications first
        await this.prisma.serviceNotification.deleteMany({ where: { serviceId } });

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
            },
        }));
    }

    async selectCaregiver(userId: string, serviceId: string, caregiverId: string) {
        const family = await this.prisma.family.findUnique({ where: { userId } });
        if (!family) throw new NotFoundException('Family profile not found');

        const service = await this.prisma.service.findUnique({ where: { id: serviceId } });
        if (!service) throw new NotFoundException('Service not found');
        if (service.familyId !== family.id) throw new NotFoundException('Service not found');
        if (service.status !== 'matched') throw new Error('Service is not in matched state');

        return this.matchingService.selectCaregiver(serviceId, caregiverId);
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
}

