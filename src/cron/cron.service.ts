import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { MatchingService } from '../matching/matching.service';
import { TelegramService } from '../telegram/telegram.service';
import { MailService } from '../mail/mail.service';
import { QueueService } from '../queue/queue.service';

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
        private queueService: QueueService,
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

    /**
     * Daily at 4am: perform the final hard-delete for user accounts that
     * have been soft-deleted for more than HARD_DELETE_GRACE_DAYS. We delete
     * the User row cascade — Mongo does not enforce FK so child docs
     * (Caregiver, Family, ServiceNotification, Reviews, CriminalRecords)
     * are removed explicitly in that order to avoid orphans.
     *
     * Services and Chats are retained in anonymized form because they
     * involve the OTHER party and live invoices; deleting them would break
     * fiscal traceability for the operator (monotributo).
     */
    @Cron('0 4 * * *')
    async purgeSoftDeletedUsers() {
        const HARD_DELETE_GRACE_DAYS = 30;
        const cutoff = new Date(Date.now() - HARD_DELETE_GRACE_DAYS * 24 * 60 * 60 * 1000);

        try {
            const toPurge = await this.prisma.user.findMany({
                where: { deletedAt: { lt: cutoff } },
                select: { id: true },
            });
            if (toPurge.length === 0) return;

            this.logger.log(`Cron: purging ${toPurge.length} soft-deleted user(s) past grace window`);

            for (const { id } of toPurge) {
                try {
                    await this.prisma.$transaction([
                        this.prisma.serviceNotification.deleteMany({ where: { caregiver: { userId: id } } }),
                        this.prisma.criminalRecord.deleteMany({ where: { userId: id } }),
                        this.prisma.review.deleteMany({ where: { reviewerId: id } }),
                        this.prisma.caregiver.deleteMany({ where: { userId: id } }),
                        this.prisma.family.deleteMany({ where: { userId: id } }),
                        this.prisma.passwordReset.deleteMany({ where: { userId: id } }),
                        this.prisma.user.delete({ where: { id } }),
                    ]);
                } catch (err) {
                    this.logger.error(`Cron: failed to purge user ${id}`, err);
                }
            }
        } catch (err) {
            this.logger.error('Cron: Error in purgeSoftDeletedUsers', err);
        }
    }

    // ─── Virtual services: lifecycle + recordatorios + payouts ─────────────

    /**
     * Cada 5 minutos: recordatorios de VideoSessions próximas.
     *
     * - 24h antes (±5min): push + email a familia y cuidador.
     * - 15 min antes (±5min): push adicional con botón "Unirse".
     *
     * Idempotente via flags `remindedAt24h` / `remindedAt15m` en VideoSession.
     */
    @Cron(CronExpression.EVERY_5_MINUTES)
    async sendVideoSessionReminders() {
        const now = Date.now();
        const win = 5 * 60 * 1000; // margen de 5 minutos
        const t24h = now + 24 * 60 * 60 * 1000;
        const t15m = now + 15 * 60 * 1000;

        try {
            // 24h: sesiones cuyo startAt cae en [now+24h-5min, now+24h+5min].
            const for24h = await this.prisma.videoSession.findMany({
                where: {
                    status: 'scheduled',
                    remindedAt24h: null,
                    startAt: {
                        gte: new Date(t24h - win),
                        lte: new Date(t24h + win),
                    },
                },
            });
            for (const vs of for24h) {
                await this.notifyVideoSessionParties(vs, '24h');
                await this.prisma.videoSession.update({
                    where: { id: vs.id },
                    data: { remindedAt24h: new Date() },
                });
            }

            // 15m: sesiones cuyo startAt cae en [now+15m-5min, now+15m+5min].
            const for15m = await this.prisma.videoSession.findMany({
                where: {
                    status: { in: ['scheduled', 'ready'] },
                    remindedAt15m: null,
                    startAt: {
                        gte: new Date(t15m - win),
                        lte: new Date(t15m + win),
                    },
                },
            });
            for (const vs of for15m) {
                await this.notifyVideoSessionParties(vs, '15m');
                await this.prisma.videoSession.update({
                    where: { id: vs.id },
                    data: { remindedAt15m: new Date() },
                });
            }

            const sent = for24h.length + for15m.length;
            if (sent > 0) {
                this.logger.log(`Cron: sent ${sent} video-session reminders (${for24h.length} × 24h, ${for15m.length} × 15m)`);
            }
        } catch (err) {
            this.logger.error('Cron: Error in sendVideoSessionReminders', err);
        }
    }

    private async notifyVideoSessionParties(
        vs: { id: string; serviceId: string; familyId: string; caregiverId: string; startAt: Date },
        when: '24h' | '15m',
    ) {
        const [family, caregiver] = await Promise.all([
            this.prisma.family.findUnique({
                where: { id: vs.familyId },
                include: { user: { select: { id: true, email: true, firstName: true, name: true } } },
            }),
            this.prisma.caregiver.findUnique({
                where: { id: vs.caregiverId },
                include: { user: { select: { id: true, email: true, firstName: true, name: true } } },
            }),
        ]);
        if (!family?.user || !caregiver?.user) return;

        const title = when === '24h' ? '📅 Sesión mañana' : '⏰ Tu sesión empieza en 15 min';
        const time = vs.startAt.toLocaleString('es-AR', {
            timeZone: 'America/Argentina/Buenos_Aires',
            hour: '2-digit',
            minute: '2-digit',
            day: '2-digit',
            month: '2-digit',
        });
        const body = when === '24h'
            ? `Recordá tu sesión del ${time}`
            : `Unite ahora para tu sesión de las ${time}`;

        for (const party of [family.user, caregiver.user]) {
            this.queueService.enqueuePush(
                party.id,
                title,
                body,
                { type: 'video-session-reminder', videoSessionId: vs.id, when },
            ).catch(e => this.logger.error(`Reminder push failed for ${party.id}`, e));
        }
    }

    /**
     * Cada 10 minutos: cierra VideoSessions cuyo `endAt` ya pasó, dispara
     * transición del Service a `completed` si todas sus sesiones están en
     * estado terminal, y avisa por Telegram.
     */
    @Cron(CronExpression.EVERY_10_MINUTES)
    async closeExpiredVideoSessions() {
        const now = new Date();
        try {
            const stale = await this.prisma.videoSession.findMany({
                where: {
                    status: { in: ['scheduled', 'ready', 'in_progress'] },
                    endAt: { lt: now },
                },
                select: { id: true, serviceId: true },
            });
            if (stale.length === 0) return;

            const affectedServices = new Set<string>();
            for (const vs of stale) {
                await this.prisma.videoSession.update({
                    where: { id: vs.id },
                    data: { status: 'completed' },
                });
                affectedServices.add(vs.serviceId);
            }

            // Revisar cada Service afectado: si todas sus sesiones están en
            // estado terminal, marcar el Service como completed.
            for (const serviceId of affectedServices) {
                const remaining = await this.prisma.videoSession.count({
                    where: {
                        serviceId,
                        status: { notIn: ['completed', 'cancelled'] },
                    },
                });
                if (remaining > 0) continue;

                const service = await this.prisma.service.findUnique({
                    where: { id: serviceId },
                    include: {
                        family: { include: { user: { select: { name: true, firstName: true } } } },
                        caregiver: { include: { user: { select: { name: true, firstName: true } } } },
                    },
                });
                if (!service || service.status === 'completed' || service.status === 'cancelled') continue;
                if (service.modality !== 'virtual') continue;

                await this.prisma.service.update({
                    where: { id: serviceId },
                    data: { status: 'completed', actualEnd: now },
                });

                const familyName = service.family?.user?.name || service.family?.user?.firstName || 'Familia';
                const caregiverName = service.caregiver?.user?.name || service.caregiver?.user?.firstName || 'Cuidador';
                this.telegramService.sendLog('service.completed', {
                    serviceId,
                    modality: 'virtual',
                    family: familyName,
                    caregiver: caregiverName,
                } as any).catch(() => undefined);
            }

            this.logger.log(`Cron: closed ${stale.length} expired video sessions (${affectedServices.size} services reviewed)`);
        } catch (err) {
            this.logger.error('Cron: Error in closeExpiredVideoSessions', err);
        }
    }

    /**
     * Cada hora: busca payouts `pending` cuyas sesiones de la semana ya están
     * todas en estado terminal (completed/cancelled), los pasa a `releasable`
     * y avisa al admin por Telegram para que libere.
     *
     * Para payouts presenciales: transiciona a releasable cuando el Service
     * está en `completed`.
     */
    @Cron(CronExpression.EVERY_HOUR)
    async settleReleasablePayouts() {
        try {
            const pending = await this.prisma.servicePayout.findMany({
                where: { status: 'pending' },
                orderBy: { createdAt: 'asc' },
            });
            if (pending.length === 0) return;

            let marked = 0;
            for (const payout of pending) {
                const ready = await this.isPayoutReleasable(payout);
                if (!ready) continue;

                const releasableAt = new Date();
                await this.prisma.servicePayout.update({
                    where: { id: payout.id },
                    data: { status: 'releasable', releasableAt },
                });

                // Aviso único por payout — se marca notifiedAt para evitar
                // duplicados con el cron de "overdue" siguiente.
                await this.notifyPayoutPending(payout.id);
                marked++;
            }

            if (marked > 0) {
                this.logger.log(`Cron: ${marked} payout(s) transicionaron a releasable`);
            }
        } catch (err) {
            this.logger.error('Cron: Error in settleReleasablePayouts', err);
        }
    }

    private async isPayoutReleasable(payout: {
        serviceId: string;
        weekStartAt: Date | null;
        weekEndAt: Date | null;
    }): Promise<boolean> {
        // Presencial: releasable cuando el Service global está completed.
        if (!payout.weekStartAt || !payout.weekEndAt) {
            const service = await this.prisma.service.findUnique({
                where: { id: payout.serviceId },
                select: { status: true, paymentStatus: true },
            });
            return service?.status === 'completed' && service?.paymentStatus === 'retenido';
        }
        // Virtual: releasable cuando todas las VideoSessions cuya startAt
        // cae en la semana están en estado terminal. Si no hay sesiones en
        // la semana (raro, paquete mal planificado) lo consideramos listo.
        const sessions = await this.prisma.videoSession.findMany({
            where: {
                serviceId: payout.serviceId,
                startAt: { gte: payout.weekStartAt, lte: payout.weekEndAt },
            },
            select: { status: true },
        });
        if (sessions.length === 0) return true;
        return sessions.every(s => s.status === 'completed' || s.status === 'cancelled');
    }

    private async notifyPayoutPending(payoutId: string) {
        const payout = await this.prisma.servicePayout.findUnique({
            where: { id: payoutId },
            include: {
                service: {
                    include: {
                        caregiver: { include: { user: { select: { name: true, firstName: true } } } },
                    },
                },
            },
        });
        if (!payout) return;

        const caregiverName = payout.service.caregiver?.user?.name
            || payout.service.caregiver?.user?.firstName
            || 'Cuidador';

        const weekRange = payout.weekStartAt && payout.weekEndAt
            ? `${payout.weekStartAt.toLocaleDateString('es-AR')} → ${payout.weekEndAt.toLocaleDateString('es-AR')}`
            : '—';

        this.telegramService.sendLog('payout.pending_release', {
            payoutId: payout.id,
            serviceId: payout.serviceId,
            modality: payout.service.modality,
            caregiver: caregiverName,
            amount: `$${payout.amount.toLocaleString('es-AR')}`,
            weekIndex: payout.weekIndex,
            weekRange,
        } as any).catch(() => undefined);

        await this.prisma.servicePayout.update({
            where: { id: payoutId },
            data: { notifiedAt: new Date() },
        });
    }

    /**
     * Diario a las 10am: recordá al admin payouts `releasable` hace más de
     * 24h sin liberar. Protege contra el caso de que el aviso original de
     * Telegram se perdió o nadie lo leyó.
     */
    @Cron('0 10 * * *')
    async remindOverduePayouts() {
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        try {
            const overdue = await this.prisma.servicePayout.findMany({
                where: {
                    status: 'releasable',
                    releasableAt: { lt: oneDayAgo },
                },
                include: {
                    service: {
                        include: {
                            caregiver: { include: { user: { select: { name: true, firstName: true } } } },
                        },
                    },
                },
            });
            if (overdue.length === 0) return;

            for (const p of overdue) {
                const caregiverName = p.service.caregiver?.user?.name
                    || p.service.caregiver?.user?.firstName
                    || 'Cuidador';
                const daysWaiting = Math.floor(
                    (Date.now() - (p.releasableAt?.getTime() ?? 0)) / (24 * 60 * 60 * 1000),
                );
                this.telegramService.sendLog('payout.release_overdue', {
                    payoutId: p.id,
                    serviceId: p.serviceId,
                    caregiver: caregiverName,
                    amount: `$${p.amount.toLocaleString('es-AR')}`,
                    daysWaiting,
                } as any).catch(() => undefined);
            }

            this.logger.log(`Cron: avisados ${overdue.length} payout(s) atrasados para liberar`);
        } catch (err) {
            this.logger.error('Cron: Error in remindOverduePayouts', err);
        }
    }
}
