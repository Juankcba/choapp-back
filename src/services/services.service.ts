import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ServicesService {
    constructor(private prisma: PrismaService) { }

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

    async acceptService(serviceId: string, userId: string) {
        const caregiver = await this.prisma.caregiver.findUnique({ where: { userId } });
        if (!caregiver) throw new NotFoundException('Caregiver not found');

        return this.prisma.service.update({
            where: { id: serviceId },
            data: {
                caregiverId: caregiver.id,
                status: 'accepted',
            },
        });
    }
}
