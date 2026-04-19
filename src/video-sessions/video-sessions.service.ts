import {
    Injectable,
    Logger,
    NotFoundException,
    BadRequestException,
    ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MedixalinkService } from '../medixalink/medixalink.service';
import { MatchingGateway } from '../matching/matching.gateway';
import { QueueService } from '../queue/queue.service';

// Slot del paquete recurrente. Formato persistido en Service.preferredSlots.
interface PreferredSlot {
    dayOfWeek: number;   // 0=domingo ... 6=sábado
    startTime: string;   // "HH:MM" 24h, en la zona del familiar (America/Argentina/Buenos_Aires)
    durationMin: number; // duración pactada en minutos
}

// Ventana para considerar una sesión "ready" y permitir que se una.
const JOIN_WINDOW_BEFORE_MIN = 15;
// Tolerancia después del endAt en la que todavía permitimos unirse (late join).
const JOIN_WINDOW_AFTER_MIN = 10;

@Injectable()
export class VideoSessionsService {
    private readonly logger = new Logger(VideoSessionsService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly medixalink: MedixalinkService,
        private readonly matchingGateway: MatchingGateway,
        private readonly queueService: QueueService,
    ) { }

    /**
     * Materializa un paquete de sesiones para un Service virtual aceptado.
     * Genera sesiones puntuales (VideoSession) a partir de `preferredSlots` y
     * `sessionsPerWeek`, para las próximas `weeks` semanas contadas desde
     * `startFrom` (default: ahora).
     *
     * Idempotencia: si ya hay VideoSessions en la ventana, no crea duplicados;
     * extiende agregando las que falten.
     */
    async materializeForService(
        serviceId: string,
        opts: { weeks?: number; startFrom?: Date } = {},
    ): Promise<{ created: number; skipped: number }> {
        const weeks = opts.weeks ?? 4;
        const startFrom = opts.startFrom ?? new Date();

        const service = await this.prisma.service.findUnique({
            where: { id: serviceId },
        });
        if (!service) throw new NotFoundException('Service no encontrado');
        if (service.modality !== 'virtual') {
            throw new BadRequestException(
                'Solo los servicios virtuales materializan sesiones de video',
            );
        }
        if (!service.caregiverId) {
            throw new BadRequestException(
                'El servicio aún no tiene cuidador asignado',
            );
        }
        const slots = (service.preferredSlots ?? []) as unknown as PreferredSlot[];
        if (slots.length === 0) {
            throw new BadRequestException(
                'El servicio no tiene horarios preferidos pactados',
            );
        }
        const perWeek = service.sessionsPerWeek ?? slots.length;

        // Genero los startAt en la ventana [startFrom, startFrom + weeks].
        const planned: Array<{ startAt: Date; endAt: Date }> = [];
        for (let w = 0; w < weeks; w++) {
            // Solo tomamos `perWeek` slots por semana — si el usuario definió
            // más slots preferidos que `sessionsPerWeek`, usamos los primeros.
            const weekSlots = slots.slice(0, perWeek);
            for (const slot of weekSlots) {
                const startAt = nextOccurrenceOfSlot(startFrom, slot, w);
                if (startAt.getTime() < startFrom.getTime()) continue;
                const endAt = new Date(startAt.getTime() + slot.durationMin * 60_000);
                planned.push({ startAt, endAt });
            }
        }

        // Existentes en la misma ventana (para evitar duplicados por re-run).
        const existing = await this.prisma.videoSession.findMany({
            where: {
                serviceId,
                startAt: {
                    gte: startFrom,
                    lte: new Date(startFrom.getTime() + weeks * 7 * 24 * 60 * 60_000),
                },
            },
            select: { startAt: true },
        });
        const existingKeys = new Set(existing.map(e => e.startAt.toISOString()));

        let created = 0;
        let skipped = 0;
        for (const p of planned) {
            if (existingKeys.has(p.startAt.toISOString())) {
                skipped++;
                continue;
            }
            await this.prisma.videoSession.create({
                data: {
                    serviceId,
                    familyId: service.familyId,
                    caregiverId: service.caregiverId,
                    startAt: p.startAt,
                    endAt: p.endAt,
                    status: 'scheduled',
                },
            });
            created++;
        }

        this.logger.log(
            `Service ${serviceId}: materializadas ${created} sesiones (${skipped} ya existían)`,
        );
        return { created, skipped };
    }

    /**
     * Devuelve la info para que un participante (familia o cuidador) se una a
     * la videollamada: roomName, dominio y JWT firmado por medixalink.
     *
     * Sólo se entrega dentro de la ventana [startAt - 15min, endAt + 10min].
     * Fuera de esa ventana la sesión se considera no accesible.
     */
    async getJoinInfo(videoSessionId: string, userId: string) {
        const session = await this.prisma.videoSession.findUnique({
            where: { id: videoSessionId },
        });
        if (!session) throw new NotFoundException('Sesión no encontrada');
        if (session.status === 'cancelled') {
            throw new BadRequestException('La sesión fue cancelada');
        }

        // Resuelvo la identidad del usuario que pide el link. Tiene que ser
        // la familia o el cuidador de la sesión.
        const [family, caregiver] = await Promise.all([
            this.prisma.family.findUnique({
                where: { id: session.familyId },
                include: {
                    user: { select: { id: true, email: true, firstName: true, lastName: true, name: true } },
                },
            }),
            this.prisma.caregiver.findUnique({
                where: { id: session.caregiverId },
                include: {
                    user: { select: { id: true, email: true, firstName: true, lastName: true, name: true } },
                },
            }),
        ]);
        if (!family || !caregiver) {
            throw new NotFoundException('Familia o cuidador no encontrado');
        }

        let role: 'family' | 'caregiver';
        if (family.user.id === userId) role = 'family';
        else if (caregiver.user.id === userId) role = 'caregiver';
        else throw new ForbiddenException('No sos parte de esta sesión');

        // Gate de pago según el scheme del service. upfront_full: el service
        // global tiene que estar pago. per_session: la VideoSession tiene
        // que estar paga. Sin pago no se emite el JWT a Jitsi.
        const parentServicePre = await this.prisma.service.findUnique({
            where: { id: session.serviceId },
            select: { paymentStatus: true, paymentScheme: true, modality: true },
        });
        if (parentServicePre?.modality === 'virtual') {
            const isPerSession = parentServicePre.paymentScheme === 'per_session';
            if (isPerSession) {
                if (session.paymentStatus !== 'retenido' && session.paymentStatus !== 'released') {
                    throw new BadRequestException(
                        role === 'family'
                            ? 'Tenés que pagar esta sesión antes de unirte'
                            : 'La familia todavía no pagó esta sesión',
                    );
                }
            } else {
                if (parentServicePre.paymentStatus !== 'retenido' && parentServicePre.paymentStatus !== 'released') {
                    throw new BadRequestException(
                        role === 'family'
                            ? 'El paquete todavía no está pago'
                            : 'El paquete todavía no está pago por la familia',
                    );
                }
            }
        }

        // Ventana de apertura.
        const now = Date.now();
        const openAt = session.startAt.getTime() - JOIN_WINDOW_BEFORE_MIN * 60_000;
        const closeAt = session.endAt.getTime() + JOIN_WINDOW_AFTER_MIN * 60_000;
        if (now < openAt) {
            throw new BadRequestException('Todavía no se puede unir a la sesión');
        }
        if (now > closeAt) {
            throw new BadRequestException('La sesión ya terminó');
        }

        const durationMin = Math.max(
            1,
            Math.ceil((session.endAt.getTime() - session.startAt.getTime()) / 60_000),
        );

        const tokens = await this.medixalink.requestSessionTokens({
            sessionId: session.id,
            startAt: session.startAt,
            durationMin,
            caregiver: {
                name: formatName(caregiver.user),
                email: caregiver.user.email,
            },
            family: {
                name: formatName(family.user),
                email: family.user.email,
            },
        });

        // Marcamos la sesión como `ready` en su primer acceso; registramos el
        // timestamp de ingreso por rol (informativo, no cambia auth).
        const updates: Record<string, unknown> = {};
        if (session.status === 'scheduled') updates.status = 'ready';
        if (role === 'family' && !session.familyJoinedAt) {
            updates.familyJoinedAt = new Date();
        }
        if (role === 'caregiver' && !session.caregiverJoinedAt) {
            updates.caregiverJoinedAt = new Date();
        }
        if (Object.keys(updates).length > 0) {
            await this.prisma.videoSession.update({
                where: { id: session.id },
                data: updates,
            });
        }

        // Transicionar el Service a `in_progress` en el primer join de
        // cualquier participante a cualquier VideoSession del paquete. El
        // cuidador no tiene que tocar un botón manual como en presencial.
        const parentService = await this.prisma.service.findUnique({
            where: { id: session.serviceId },
            select: { id: true, status: true, actualStart: true },
        });
        if (parentService && parentService.status === 'accepted') {
            await this.prisma.service.update({
                where: { id: parentService.id },
                data: {
                    status: 'in_progress',
                    actualStart: parentService.actualStart ?? new Date(),
                },
            });
        }

        return {
            sessionId: session.id,
            roomName: tokens.roomName,
            videoDomain: tokens.videoDomain,
            token: role === 'caregiver' ? tokens.moderatorToken : tokens.participantToken,
            role,
            startAt: session.startAt.toISOString(),
            endAt: session.endAt.toISOString(),
            expiresAt: tokens.expiresAt,
        };
    }

    /**
     * Lista sesiones futuras y recientes para un usuario (familia o cuidador).
     * Incluye las de los últimos 7 días para que el cliente muestre historial
     * inmediato.
     */
    async listForUser(userId: string) {
        const [family, caregiver] = await Promise.all([
            this.prisma.family.findUnique({ where: { userId } }),
            this.prisma.caregiver.findUnique({ where: { userId } }),
        ]);

        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60_000);
        const where: any = { startAt: { gte: sevenDaysAgo } };
        if (family) where.familyId = family.id;
        else if (caregiver) where.caregiverId = caregiver.id;
        else return [];

        return this.prisma.videoSession.findMany({
            where,
            orderBy: { startAt: 'asc' },
        });
    }

    /**
     * Lista todas las VideoSessions de un Service puntual. Exige que el
     * usuario sea la familia o el cuidador del service; de lo contrario
     * lanza Forbidden. No filtra por ventana temporal — devuelve el paquete
     * completo (materializado), útil para la pantalla de detalle.
     */
    async listForService(serviceId: string, userId: string) {
        const service = await this.prisma.service.findUnique({
            where: { id: serviceId },
            select: { id: true, familyId: true, caregiverId: true },
        });
        if (!service) throw new NotFoundException('Service no encontrado');

        const [family, caregiver] = await Promise.all([
            this.prisma.family.findUnique({ where: { userId } }),
            this.prisma.caregiver.findUnique({ where: { userId } }),
        ]);

        const isFamily = family && family.id === service.familyId;
        const isCaregiver = caregiver && caregiver.id === service.caregiverId;
        if (!isFamily && !isCaregiver) {
            throw new ForbiddenException('No sos parte de este servicio');
        }

        return this.prisma.videoSession.findMany({
            where: { serviceId },
            orderBy: { startAt: 'asc' },
        });
    }

    async cancel(
        videoSessionId: string,
        userId: string,
        reason: string | undefined,
    ) {
        const session = await this.prisma.videoSession.findUnique({
            where: { id: videoSessionId },
        });
        if (!session) throw new NotFoundException('Sesión no encontrada');
        if (session.status === 'cancelled') return session;
        if (session.status === 'completed') {
            throw new BadRequestException('La sesión ya terminó');
        }

        const [family, caregiver] = await Promise.all([
            this.prisma.family.findUnique({ where: { id: session.familyId } }),
            this.prisma.caregiver.findUnique({ where: { id: session.caregiverId } }),
        ]);
        let cancelledBy: 'family' | 'caregiver';
        if (family?.userId === userId) cancelledBy = 'family';
        else if (caregiver?.userId === userId) cancelledBy = 'caregiver';
        else throw new ForbiddenException('No sos parte de esta sesión');

        const updated = await this.prisma.videoSession.update({
            where: { id: session.id },
            data: {
                status: 'cancelled',
                cancelledBy,
                cancelledReason: reason,
            },
        });

        // Notificar a la contraparte. Cuando la familia cancela, el cuidador
        // tiene que saberlo (bloqueó la hora en su agenda). Lo mismo al revés.
        const otherUserId = cancelledBy === 'family'
            ? caregiver?.userId
            : family?.userId;
        if (otherUserId) {
            const startTxt = session.startAt.toLocaleString('es-AR', {
                timeZone: 'America/Argentina/Buenos_Aires',
                day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
            });
            this.matchingGateway.emitToUser(otherUserId, 'video-session-cancelled', {
                videoSessionId: session.id,
                serviceId: session.serviceId,
                startAt: session.startAt.toISOString(),
                cancelledBy,
                reason,
            });
            this.queueService.enqueuePush(
                otherUserId,
                '❌ Sesión cancelada',
                `La sesión del ${startTxt} fue cancelada${reason ? `: ${reason}` : ''}`,
                { type: 'video-session-cancelled', videoSessionId: session.id, serviceId: session.serviceId },
            ).catch(e => this.logger.error('Push cancel failed', e));
        }

        return updated;
    }

    /**
     * Reagenda una VideoSession a un nuevo startAt (y opcionalmente cambia su
     * duración). Solo la familia del service puede hacerlo — la familia es
     * dueña del servicio y quien acordó el cambio por chat. El cuidador
     * recibe push + websocket con la nueva fecha.
     *
     * No permite:
     *  - Mover una sesión al pasado.
     *  - Reagendar sesiones `completed`, `cancelled` ni `in_progress`.
     *
     * Efectos secundarios: resetea los flags de recordatorios (`remindedAt24h`,
     * `remindedAt15m`) para que el cron los vuelva a disparar con la fecha
     * nueva.
     */
    async reschedule(
        videoSessionId: string,
        userId: string,
        newStartAt: Date,
        newDurationMin?: number,
    ) {
        const session = await this.prisma.videoSession.findUnique({
            where: { id: videoSessionId },
        });
        if (!session) throw new NotFoundException('Sesión no encontrada');
        if (session.status === 'cancelled') {
            throw new BadRequestException('La sesión está cancelada');
        }
        if (session.status === 'completed') {
            throw new BadRequestException('La sesión ya terminó');
        }
        if (session.status === 'in_progress') {
            throw new BadRequestException('No se puede reagendar una sesión en curso');
        }
        if (newStartAt.getTime() <= Date.now()) {
            throw new BadRequestException('La nueva fecha tiene que ser en el futuro');
        }

        const [family, caregiver] = await Promise.all([
            this.prisma.family.findUnique({ where: { id: session.familyId } }),
            this.prisma.caregiver.findUnique({ where: { id: session.caregiverId } }),
        ]);
        if (family?.userId !== userId) {
            throw new ForbiddenException('Solo la familia puede reagendar una sesión');
        }

        // Conservar la duración original si no pasaron una nueva.
        const currentDurationMs = session.endAt.getTime() - session.startAt.getTime();
        const currentDurationMin = Math.max(1, Math.round(currentDurationMs / 60_000));
        const durationMin = newDurationMin ?? currentDurationMin;
        const newEndAt = new Date(newStartAt.getTime() + durationMin * 60_000);

        const updated = await this.prisma.videoSession.update({
            where: { id: session.id },
            data: {
                startAt: newStartAt,
                endAt: newEndAt,
                // Si la sesión estaba `ready` (dentro de la ventana de join),
                // con la nueva fecha vuelve a `scheduled`.
                status: 'scheduled',
                // Reset de flags para que el cron la vuelva a recordar.
                remindedAt24h: null,
                remindedAt15m: null,
            },
        });

        // Notificar al cuidador — reagendamiento es un cambio fuerte, no
        // puede perdérselo.
        if (caregiver?.userId) {
            const newStartTxt = newStartAt.toLocaleString('es-AR', {
                timeZone: 'America/Argentina/Buenos_Aires',
                day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
            });
            this.matchingGateway.emitToUser(caregiver.userId, 'video-session-rescheduled', {
                videoSessionId: session.id,
                serviceId: session.serviceId,
                startAt: newStartAt.toISOString(),
                endAt: newEndAt.toISOString(),
            });
            this.queueService.enqueuePush(
                caregiver.userId,
                '📅 Sesión reagendada',
                `Nueva fecha: ${newStartTxt}`,
                { type: 'video-session-rescheduled', videoSessionId: session.id, serviceId: session.serviceId },
            ).catch(e => this.logger.error('Push reschedule failed', e));
        }

        this.logger.log(
            `VideoSession ${session.id} reagendada por familia ${userId} → ${newStartAt.toISOString()}`,
        );
        return updated;
    }
}

function formatName(user: {
    firstName: string | null;
    lastName: string | null;
    name: string | null;
}): string {
    return (
        user.name ||
        `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() ||
        'Usuario'
    );
}

/**
 * Calcula el próximo `Date` que caiga en `slot.dayOfWeek` a partir de `from`,
 * luego suma `weekOffset` semanas y aplica la hora `slot.startTime`.
 * Trabaja en local time — asume que el servidor usa la misma TZ que el
 * familiar (Argentina para los 60 usuarios actuales). Cuando cho soporte
 * usuarios en múltiples husos, moverlo a una lib TZ-aware.
 */
function nextOccurrenceOfSlot(
    from: Date,
    slot: PreferredSlot,
    weekOffset: number,
): Date {
    const [hStr, mStr] = slot.startTime.split(':');
    const h = Number(hStr);
    const m = Number(mStr);
    const base = new Date(from);
    const currentDow = base.getDay();
    let diffDays = slot.dayOfWeek - currentDow;
    if (diffDays < 0) diffDays += 7;
    base.setDate(base.getDate() + diffDays + weekOffset * 7);
    base.setHours(h, m, 0, 0);
    return base;
}
