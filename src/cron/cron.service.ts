import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { MatchingService } from '../matching/matching.service';

@Injectable()
export class CronService {
    private readonly logger = new Logger(CronService.name);

    constructor(
        private prisma: PrismaService,
        private matchingService: MatchingService,
    ) { }

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
                    _count: { select: { notifications: true } },
                },
            });

            // Only re-notify for services with few interested caregivers
            const needsMatching = pendingServices.filter(
                (s) => (s as any)._count?.notifications < 5,
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
