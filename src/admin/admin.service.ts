import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AdminService {
    constructor(private prisma: PrismaService) { }

    async getStats() {
        const [totalUsers, totalCaregivers, totalFamilies, totalServices, activeServices] =
            await Promise.all([
                this.prisma.user.count(),
                this.prisma.caregiver.count(),
                this.prisma.family.count(),
                this.prisma.service.count(),
                this.prisma.service.count({ where: { status: { in: ['pending', 'accepted', 'inProgress'] } } }),
            ]);

        return { totalUsers, totalCaregivers, totalFamilies, totalServices, activeServices };
    }

    async getPendingCaregivers() {
        // Get all valid user IDs to avoid orphaned caregiver records
        const validUserIds = (await this.prisma.user.findMany({ select: { id: true } })).map(u => u.id);

        return this.prisma.caregiver.findMany({
            where: {
                verificationStatus: 'pending',
                userId: { in: validUserIds },
            },
            include: { user: { select: { email: true, firstName: true, lastName: true, name: true, phone: true, createdAt: true } } },
            orderBy: { createdAt: 'desc' },
        });
    }

    async verifyCaregiver(caregiverId: string, approved: boolean) {
        return this.prisma.caregiver.update({
            where: { id: caregiverId },
            data: { verificationStatus: approved ? 'verified' : 'rejected' },
        });
    }

    async getActiveServices() {
        return this.prisma.service.findMany({
            where: { status: { in: ['pending', 'accepted', 'inProgress'] } },
            include: {
                family: { include: { user: { select: { firstName: true, lastName: true } } } },
                caregiver: { include: { user: { select: { firstName: true, lastName: true } } } },
            },
            orderBy: { createdAt: 'desc' },
        });
    }
}
