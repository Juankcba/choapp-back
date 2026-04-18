import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { MatchingService } from '../matching/matching.service';
import { TelegramService } from '../telegram/telegram.service';
import { MailService } from '../mail/mail.service';

// A chat message is considered "unread long enough" when it has been sitting
// in the DB for this many ms without being opened by its recipient. After
// that, a fallback email is sent.
export const UNREAD_EMAIL_DELAY_MS = 10 * 60 * 1000;

// Don't look further back than this when scanning for unread messages. Keeps
// the cron cheap and prevents a fresh deployment from spamming about very old
// messages that predate the feature.
export const UNREAD_LOOKBACK_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class CronService {
    private readonly logger = new Logger(CronService.name);

    constructor(
        private prisma: PrismaService,
        private matchingService: MatchingService,
        private telegramService: TelegramService,
        private mailService: MailService,
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

    /**
     * Every 2 minutes: email the recipient of any chat message that has been
     * unread for more than `UNREAD_EMAIL_DELAY_MS`. The `notifiedByEmail` flag
     * on each embedded message prevents duplicates.
     *
     * Grouping: all unread messages from the same sender in the same chat are
     * collapsed into a single email ("(N mensajes nuevos) Último: ...").
     */
    @Cron('*/2 * * * *')
    async checkUnreadMessages() {
        const now = Date.now();
        const staleBefore = new Date(now - UNREAD_EMAIL_DELAY_MS);
        const lookbackAfter = new Date(now - UNREAD_LOOKBACK_MS);

        try {
            const chats = await this.prisma.chat.findMany({
                where: { updatedAt: { gte: lookbackAfter } },
                include: {
                    service: {
                        select: {
                            id: true,
                            family: {
                                select: {
                                    user: { select: { id: true, email: true, name: true, firstName: true } },
                                },
                            },
                            caregiver: {
                                select: {
                                    user: { select: { id: true, email: true, name: true, firstName: true } },
                                },
                            },
                        },
                    },
                },
            });

            let emailsSent = 0;

            for (const chat of chats) {
                const familyUser = chat.service?.family?.user;
                const caregiverUser = chat.service?.caregiver?.user;
                if (!familyUser?.id || !caregiverUser?.id) continue;

                const pending = chat.messages.filter(
                    (m) =>
                        !m.read &&
                        !m.notifiedByEmail &&
                        m.timestamp >= lookbackAfter &&
                        m.timestamp < staleBefore,
                );
                if (pending.length === 0) continue;

                // Group pending messages by sender (a 1v1 chat can have unread
                // messages on both sides if nobody opened it).
                const bySender = new Map<string, typeof pending>();
                for (const m of pending) {
                    const list = bySender.get(m.senderId) ?? [];
                    list.push(m);
                    bySender.set(m.senderId, list);
                }

                for (const [senderId, msgs] of bySender) {
                    let recipientEmail: string | undefined;
                    let recipientName: string;
                    let senderName: string;

                    if (senderId === familyUser.id) {
                        recipientEmail = caregiverUser.email;
                        recipientName = caregiverUser.name || caregiverUser.firstName || 'Cuidador';
                        senderName = familyUser.name || familyUser.firstName || 'Familia';
                    } else if (senderId === caregiverUser.id) {
                        recipientEmail = familyUser.email;
                        recipientName = familyUser.name || familyUser.firstName || 'Familia';
                        senderName = caregiverUser.name || caregiverUser.firstName || 'Cuidador';
                    } else {
                        continue;
                    }

                    if (!recipientEmail) continue;

                    const lastMsg = msgs[msgs.length - 1];
                    const preview = msgs.length > 1
                        ? `(${msgs.length} mensajes nuevos) Último: ${lastMsg.content}`
                        : lastMsg.content;

                    try {
                        await this.mailService.sendChatNotificationEmail(
                            recipientEmail,
                            recipientName,
                            senderName,
                            preview,
                            chat.serviceId,
                        );
                        emailsSent++;
                    } catch (err) {
                        this.logger.error(
                            `Cron: Failed to email unread-chat notification to ${recipientEmail}`,
                            err,
                        );
                        continue;
                    }

                    const flaggedIds = new Set(msgs);
                    const updated = chat.messages.map((m) =>
                        flaggedIds.has(m) ? { ...m, notifiedByEmail: true } : m,
                    );
                    await this.prisma.chat.update({
                        where: { id: chat.id },
                        data: { messages: updated },
                    });
                }
            }

            if (emailsSent > 0) {
                this.logger.log(`Cron: Sent ${emailsSent} unread-chat email notifications`);
            }
        } catch (err) {
            this.logger.error('Cron: Error in checkUnreadMessages', err);
        }
    }
}
