import {
    Injectable,
    Logger,
    NotFoundException,
    BadRequestException,
    ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MedixalinkService } from '../medixalink/medixalink.service';

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
                    status: 'inProgress',
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

        return this.prisma.videoSession.update({
            where: { id: session.id },
            data: {
                status: 'cancelled',
                cancelledBy,
                cancelledReason: reason,
            },
        });
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
