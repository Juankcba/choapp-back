import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { MatchingService } from '../matching/matching.service';
import { TelegramService } from '../telegram/telegram.service';

@Injectable()
export class CronService {
    private readonly logger = new Logger(CronService.name);

    constructor(
        private prisma: PrismaService,
        private matchingService: MatchingService,
        private telegramService: TelegramService,
    ) { }

    /**
     * Daily at 9am: check criminal records for upcoming expirations and expired ones
     */
    @Cron('0 9 * * *')
    async checkCriminalRecordExpirations() {
        this.logger.log('Cron: Checking criminal record expirations...');

        try {
            const now = new Date();
            const in30Days = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
            const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

            // Records expiring in next 30 days OR already expired, that haven't been notified recently
            const records = await this.prisma.criminalRecord.findMany({
                where: {
                    OR: [
                        { expiresAt: { lte: in30Days, gte: now } },  // expiring soon
                        { expiresAt: { lt: now } },                    // already expired
                    ],
                    AND: [
                        {
                            OR: [
                                { notifiedAt: null },
                                { notifiedAt: { lt: sevenDaysAgo } },
                            ],
                        },
                    ],
                },
            });

            if (records.length === 0) {
                this.logger.log('Cron: No criminal records need notification');
                return;
            }

            // Get user info for each record
            const userIds = records.map(r => r.userId);
            const users = await this.prisma.user.findMany({
                where: { id: { in: userIds } },
                select: { id: true, email: true, firstName: true, lastName: true, name: true },
            });
            const userMap = new Map(users.map(u => [u.id, u]));

            for (const record of records) {
                const user = userMap.get(record.userId);
                if (!user) continue;

                const expires = new Date(record.expiresAt);
                const daysUntilExpiry = Math.floor((expires.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

                const isExpired = daysUntilExpiry < 0;
                const event = isExpired ? 'criminal_record.expired' : 'criminal_record.expiring';
                const daysText = isExpired
                    ? `Vencido hace ${Math.abs(daysUntilExpiry)} dia(s)`
                    : `Vence en ${daysUntilExpiry} dia(s)`;

                this.telegramService.sendLog(event, {
                    name: user.name || user.firstName || user.email,
                    email: user.email,
                    expiresAt: expires.toLocaleDateString('es-AR'),
                    status: daysText,
                } as any).catch(() => { /* non-blocking */ });

                // Update notifiedAt to avoid spam
                await this.prisma.criminalRecord.update({
                    where: { id: record.id },
                    data: { notifiedAt: now },
                });
            }

            this.logger.log(`Cron: Notified ${records.length} criminal record expirations`);
        } catch (err) {
            this.logger.error('Cron: Error in checkCriminalRecordExpirations', err);
        }
    }

    /**
     * Every 15 minutes, re-check pending services that have 0 interested caregivers
     * and try to find + notify nearby caregivers again.
     */
    @Cron(CronExpression.EVERY_10_MINUTES)
    async recheckPendingServices() {
        this.logger.log('🔄 Cron: Re-checking pending services for nearby caregivers...');

        try {
            const pendingServices = await this.prisma.service.findMany({
                where: {
                    status: 'pending',
                    createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }, // last 7 days
                },
                include: {
                    _count: { select: { serviceNotifications: true } },
                },
            });

            // Only re-notify for services with few interested caregivers
            const needsMatching = pendingServices.filter(
                (s) => (s as any)._count?.serviceNotifications < 5,
            );

            if (needsMatching.length === 0) {
                this.logger.log('Cron: No pending services need re-matching');
                return;
            }

            let totalNotified = 0;
            for (const service of needsMatching) {
                try {
                    const result = await this.matchingService.notifyNearbyCaregivers(service.id);
                    totalNotified += result.notified;
                } catch (err) {
                    this.logger.error(`Cron: Failed to re-match service ${service.id}`, err);
                }
            }

            this.logger.log(`Cron: Re-checked ${needsMatching.length} services, notified ${totalNotified} caregivers`);
        } catch (err) {
            this.logger.error('Cron: Error in recheckPendingServices', err);
        }
    }
}
