import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MatchingGateway } from '../matching/matching.gateway';
import { MailService } from '../mail/mail.service';

@Injectable()
export class AdminService {
    constructor(
        private prisma: PrismaService,
        private matchingGateway: MatchingGateway,
        private mailService: MailService,
    ) { }

    async getStats() {
        const [totalUsers, totalCaregivers, totalFamilies, totalServices, activeServices, paidServices, matchedServices] =
            await Promise.all([
                this.prisma.user.count(),
                this.prisma.caregiver.count(),
                this.prisma.family.count(),
                this.prisma.service.count(),
                this.prisma.service.count({ where: { status: { in: ['pending', 'matched', 'accepted', 'inProgress'] } } }),
                this.prisma.service.count({ where: { paymentStatus: { in: ['paid', 'retenido'] } } }),
                this.prisma.service.count({ where: { status: 'matched' } }),
            ]);

        return { totalUsers, totalCaregivers, totalFamilies, totalServices, activeServices, paidServices, matchedServices };
    }

    async getPendingCaregivers() {
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
        const caregiver = await this.prisma.caregiver.update({
            where: { id: caregiverId },
            data: { verificationStatus: approved ? 'verified' : 'rejected' },
            include: { user: true },
        });

        // Notify caregiver in real-time
        if (caregiver.user) {
            this.matchingGateway.emitToUser(caregiver.userId, 'account-verified', {
                status: approved ? 'verified' : 'rejected',
                message: approved
                    ? '¡Tu cuenta fue verificada! Ya podés recibir solicitudes de trabajo.'
                    : 'Tu cuenta fue rechazada. Contactá soporte para más información.',
            });

            // Send email notification
            this.mailService.sendAccountVerifiedEmail(
                caregiver.user.email,
                caregiver.user.name || caregiver.user.firstName || 'Cuidador',
                approved,
            ).catch(() => { /* non-blocking */ });
        }

        return caregiver;
    }

    async getActiveServices() {
        return this.prisma.service.findMany({
            where: { status: { in: ['pending', 'matched', 'accepted', 'inProgress'] } },
            include: {
                family: { include: { user: { select: { firstName: true, lastName: true, name: true, email: true } } } },
                caregiver: { include: { user: { select: { firstName: true, lastName: true, name: true, email: true } } } },
            },
            orderBy: { createdAt: 'desc' },
        });
    }

    async getAllServices() {
        return this.prisma.service.findMany({
            include: {
                family: { include: { user: { select: { firstName: true, lastName: true, name: true, email: true, phone: true } } } },
                caregiver: {
                    include: {
                        user: { select: { firstName: true, lastName: true, name: true, email: true, phone: true } },
                    },
                },
            },
            orderBy: { createdAt: 'desc' },
            take: 100,
        });
    }

    /**
     * Admin can read any service's chat conversation
     */
    async getServiceChat(serviceId: string) {
        const service = await this.prisma.service.findUnique({
            where: { id: serviceId },
            include: {
                family: { include: { user: { select: { firstName: true, lastName: true, name: true } } } },
                caregiver: { include: { user: { select: { firstName: true, lastName: true, name: true } } } },
            },
        });

        const chat = await this.prisma.chat.findFirst({
            where: { serviceId },
        });

        return {
            service: {
                id: service?.id,
                serviceType: service?.serviceType,
                status: service?.status,
                familyName: service?.family?.user?.name || `${service?.family?.user?.firstName || ''} ${service?.family?.user?.lastName || ''}`.trim(),
                caregiverName: service?.caregiver?.user?.name || `${service?.caregiver?.user?.firstName || ''} ${service?.caregiver?.user?.lastName || ''}`.trim(),
            },
            messages: chat?.messages || [],
        };
    }

    /**
     * Activity log: recent service state changes via notifications
     */
    async getActivityLog(limit: number = 50) {
        const [recentServices, recentNotifications] = await Promise.all([
            this.prisma.service.findMany({
                include: {
                    family: { include: { user: { select: { firstName: true, lastName: true, name: true } } } },
                    caregiver: { include: { user: { select: { firstName: true, lastName: true, name: true } } } },
                },
                orderBy: { updatedAt: 'desc' },
                take: limit,
            }),
            this.prisma.serviceNotification.findMany({
                where: { status: { in: ['interested', 'accepted', 'declined'] } },
                include: {
                    service: { select: { serviceType: true, patientName: true } },
                    caregiver: { include: { user: { select: { firstName: true, lastName: true, name: true } } } },
                },
                orderBy: { respondedAt: 'desc' },
                take: limit,
            }),
        ]);

        return { recentServices, recentNotifications };
    }

    /**
     * Payment stats for admin dashboard
     */
    async getPaymentStats() {
        const services = await this.prisma.service.findMany({
            where: { paymentStatus: { in: ['paid', 'retenido', 'released'] } },
            select: {
                amount: true,
                commissionFamily: true,
                commissionCarer: true,
                netAmount: true,
                paymentStatus: true,
            },
        });

        const totalCollected = services.reduce((sum, s) => sum + (s.amount || 0) + (s.commissionFamily || 0), 0);
        const totalCommissions = services.reduce((sum, s) => sum + (s.commissionFamily || 0) + (s.commissionCarer || 0), 0);
        const totalReleased = services.filter(s => s.paymentStatus === 'released').reduce((sum, s) => sum + (s.netAmount || 0), 0);
        const pendingRelease = services.filter(s => s.paymentStatus === 'retenido' || s.paymentStatus === 'paid').reduce((sum, s) => sum + (s.netAmount || 0), 0);

        return {
            totalCollected,
            totalCommissions,
            totalReleased,
            pendingRelease,
            totalPaidServices: services.length,
        };
    }
}
