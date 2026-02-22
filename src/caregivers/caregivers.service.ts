import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class CaregiversService {
    constructor(private prisma: PrismaService) { }

    async getProfile(userId: string) {
        const caregiver = await this.prisma.caregiver.findUnique({
            where: { userId },
            include: { user: { select: { email: true, firstName: true, lastName: true, phone: true, image: true } } },
        });
        if (!caregiver) throw new NotFoundException('Caregiver profile not found');
        return caregiver;
    }

    async updateProfile(userId: string, data: any) {
        const mappedData: any = {};

        if (data.bio !== undefined) mappedData.bio = data.bio;
        if (data.experience !== undefined) mappedData.experience = data.experience;
        if (data.hourlyRate !== undefined) mappedData.hourlyRate = data.hourlyRate;
        if (data.specialties) mappedData.specialties = data.specialties;
        if (data.locationLat !== undefined) mappedData.locationLat = data.locationLat;
        if (data.locationLng !== undefined) mappedData.locationLng = data.locationLng;
        if (data.currentLocation?.lat !== undefined) mappedData.locationLat = data.currentLocation.lat;
        if (data.currentLocation?.lng !== undefined) mappedData.locationLng = data.currentLocation.lng;
        if (data.isAvailable !== undefined) mappedData.isAvailable = data.isAvailable;

        return this.prisma.caregiver.upsert({
            where: { userId },
            update: mappedData,
            create: { userId, ...mappedData },
        });
    }

    async updateAvailability(userId: string, isAvailable: boolean) {
        return this.prisma.caregiver.update({
            where: { userId },
            data: { isAvailable },
        });
    }

    async getJobs(userId: string) {
        const caregiver = await this.prisma.caregiver.findUnique({ where: { userId } });
        if (!caregiver) throw new NotFoundException('Caregiver not found');

        return this.prisma.service.findMany({
            where: {
                OR: [
                    { caregiverId: caregiver.id },
                    { status: 'pending', caregiverId: null },
                ],
            },
            include: {
                family: {
                    include: { user: { select: { firstName: true, lastName: true, phone: true } } },
                },
            },
            orderBy: { createdAt: 'desc' },
        });
    }

    async acceptJob(userId: string, serviceId: string) {
        const caregiver = await this.prisma.caregiver.findUnique({ where: { userId } });
        if (!caregiver) throw new NotFoundException('Caregiver not found');

        return this.prisma.service.update({
            where: { id: serviceId },
            data: { caregiverId: caregiver.id, status: 'accepted' },
        });
    }

    async completeJob(userId: string, serviceId: string) {
        const caregiver = await this.prisma.caregiver.findUnique({ where: { userId } });
        if (!caregiver) throw new NotFoundException('Caregiver not found');

        const service = await this.prisma.service.update({
            where: { id: serviceId },
            data: { status: 'completed', actualEnd: new Date() },
        });

        await this.prisma.caregiver.update({
            where: { id: caregiver.id },
            data: { totalServices: { increment: 1 } },
        });

        return service;
    }
}
