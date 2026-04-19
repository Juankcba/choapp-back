import { Injectable, Logger, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { MatchingGateway } from '../matching/matching.gateway';
import { MailService } from '../mail/mail.service';
import { TelegramService } from '../telegram/telegram.service';
import { MercadoPagoConfig, Preference, Payment } from 'mercadopago';
import { FieldEncryptionService } from '../common/field-encryption.service';

@Injectable()
export class PaymentsService {
    private readonly logger = new Logger(PaymentsService.name);
    private readonly mpClient: MercadoPagoConfig;
    private readonly frontendUrl: string;
    private readonly COMMISSION_RATE = 0.10; // 10%

    constructor(
        private prisma: PrismaService,
        private configService: ConfigService,
        private matchingGateway: MatchingGateway,
        private mailService: MailService,
        private telegramService: TelegramService,
        private encryption: FieldEncryptionService,
    ) {
        const accessToken = this.configService.get<string>('MP_ACCESS_TOKEN');
        this.frontendUrl = this.configService.get<string>('FRONTEND_URL') || 'https://cho.bladelink.company';

        this.mpClient = new MercadoPagoConfig({
            accessToken: accessToken!,
        });

        this.logger.log('MercadoPago configured');
    }

    /**
     * Creates a MP checkout preference when family selects a caregiver
     */
    async createCheckout(serviceId: string, familyUserId: string) {
        const service = await this.prisma.service.findUnique({
            where: { id: serviceId },
            include: {
                family: { include: { user: true } },
                caregiver: { include: { user: true } },
            },
        });

        if (!service) throw new NotFoundException('Service not found');
        if (service.family.userId !== familyUserId) throw new BadRequestException('Not your service');
        if (!service.caregiverId) throw new BadRequestException('No caregiver assigned');

        // Calcular monto: preferimos el rate pactado (congelado al selectCaregiver)
        // sobre el actual del cuidador. Si el cuidador cambia `hourlyRate`
        // entre que lo eligieron y la familia abre el checkout, el pacto
        // anterior se respeta. Fallback a `hourlyRate` actual para services
        // legacy sin `agreedHourlyRate` (creados antes del fix).
        const caregiver = await this.prisma.caregiver.findUnique({ where: { id: service.caregiverId } });
        const effectiveRate = service.agreedHourlyRate ?? caregiver?.hourlyRate;
        if (!effectiveRate || effectiveRate <= 0) throw new BadRequestException('Caregiver hourly rate not set');

        const duration = service.duration || 1;
        const serviceAmount = effectiveRate * duration;
        const commissionFamily = serviceAmount * this.COMMISSION_RATE;
        const totalAmount = serviceAmount + commissionFamily;

        const serviceTypes: Record<string, string> = {
            elderly_care: 'Cuidado de Ancianos', special_needs: 'Necesidades Especiales',
            alzheimers: 'Alzheimer', physical_therapy: 'Terapia Física',
            companionship: 'Compañía', personal_care: 'Cuidado Personal',
        };

        const preference = new Preference(this.mpClient);
        const result = await preference.create({
            body: {
                items: [{
                    id: serviceId,
                    title: `Servicio CHO: ${serviceTypes[service.serviceType] || service.serviceType}`,
                    // patientName viene cifrado del DB: descifrar antes de
                    // mandarlo a MercadoPago (aparece en el checkout del usuario).
                    description: `Cuidado para ${this.encryption.decrypt(service.patientName) || 'paciente'} - ${duration}hs`,
                    quantity: 1,
                    unit_price: totalAmount,
                    currency_id: 'ARS',
                }],
                back_urls: {
                    success: `${this.frontendUrl}/family/services/${serviceId}?payment=success`,
                    failure: `${this.frontendUrl}/family/services/${serviceId}?payment=failure`,
                    pending: `${this.frontendUrl}/family/services/${serviceId}?payment=pending`,
                },
                auto_return: 'approved',
                external_reference: serviceId,
                notification_url: `${this.configService.get('BACKEND_URL') || 'https://choback.bladelink.company'}/api/payments/webhook`,
                metadata: {
                    service_id: serviceId,
                    family_user_id: familyUserId,
                },
            },
        });

        // Save amounts to service
        await this.prisma.service.update({
            where: { id: serviceId },
            data: {
                amount: serviceAmount,
                mpPreferenceId: result.id,
                commissionFamily,
                commissionCarer: serviceAmount * this.COMMISSION_RATE,
                netAmount: serviceAmount - (serviceAmount * this.COMMISSION_RATE),
            },
        });

        this.logger.log(`Created MP preference ${result.id} for service ${serviceId}, total: $${totalAmount}`);

        return {
            preferenceId: result.id,
            initPoint: result.init_point,
            sandboxInitPoint: result.sandbox_init_point,
            totalAmount,
            breakdown: {
                serviceAmount,
                familyCommission: commissionFamily,
                carerCommission: serviceAmount * this.COMMISSION_RATE,
                carerReceives: serviceAmount - (serviceAmount * this.COMMISSION_RATE),
                total: totalAmount,
            },
        };
    }

    /**
     * Planifica los payouts de un Service recién pagado.
     *
     * - Presencial: un único payout con amount = netAmount, weekIndex=0.
     * - Virtual: un payout por cada semana-calendario que contenga al menos
     *   una VideoSession del paquete. El monto se reparte en partes iguales
     *   entre las semanas detectadas.
     *
     * Idempotente: si ya hay payouts para el Service, no hace nada.
     *
     * Para servicios virtuales la materialización de VideoSessions corre
     * antes del checkout (ver VideoSessionsService). Si por algún motivo no
     * hay sesiones al momento del webhook, cae a un payout único (fallback
     * seguro: el admin puede liberar todo al finalizar).
     */
    async planPayouts(serviceId: string): Promise<number> {
        const existing = await this.prisma.servicePayout.count({ where: { serviceId } });
        if (existing > 0) return 0;

        const service = await this.prisma.service.findUnique({ where: { id: serviceId } });
        if (!service) throw new NotFoundException('Service not found');
        if (!service.netAmount || service.netAmount <= 0) {
            this.logger.warn(`Service ${serviceId} has no netAmount; skip payout planning`);
            return 0;
        }

        const isVirtual = service.modality === 'virtual';

        if (!isVirtual) {
            await this.prisma.servicePayout.create({
                data: {
                    serviceId,
                    weekIndex: 0,
                    amount: service.netAmount,
                    status: 'pending',
                },
            });
            return 1;
        }

        const sessions = await this.prisma.videoSession.findMany({
            where: { serviceId },
            orderBy: { startAt: 'asc' },
            select: { startAt: true },
        });
        if (sessions.length === 0) {
            // Fallback: paquete sin sesiones materializadas todavía. Creo un
            // único payout como en presencial y dejo que admin libere manual.
            this.logger.warn(`Virtual service ${serviceId} has no VideoSessions; falling back to single payout`);
            await this.prisma.servicePayout.create({
                data: {
                    serviceId,
                    weekIndex: 0,
                    amount: service.netAmount,
                    status: 'pending',
                },
            });
            return 1;
        }

        // Agrupo sesiones por semana calendar (lunes 00:00 → domingo 23:59:59.999).
        const weekMap = new Map<string, { weekStartAt: Date; weekEndAt: Date }>();
        for (const s of sessions) {
            const weekStart = startOfWeekMonday(s.startAt);
            const key = weekStart.toISOString();
            if (!weekMap.has(key)) {
                const weekEnd = new Date(weekStart);
                weekEnd.setDate(weekEnd.getDate() + 7);
                weekEnd.setMilliseconds(weekEnd.getMilliseconds() - 1);
                weekMap.set(key, { weekStartAt: weekStart, weekEndAt: weekEnd });
            }
        }

        const weeks = Array.from(weekMap.values()).sort(
            (a, b) => a.weekStartAt.getTime() - b.weekStartAt.getTime(),
        );
        const perWeek = Math.round((service.netAmount / weeks.length) * 100) / 100;
        // Ajuste final para que la suma de amounts coincida con netAmount
        // (evitar errores de centavos por redondeo). El último payout absorbe
        // el residuo.
        const residual = Math.round((service.netAmount - perWeek * weeks.length) * 100) / 100;

        for (let i = 0; i < weeks.length; i++) {
            const isLast = i === weeks.length - 1;
            await this.prisma.servicePayout.create({
                data: {
                    serviceId,
                    weekIndex: i,
                    weekStartAt: weeks[i].weekStartAt,
                    weekEndAt: weeks[i].weekEndAt,
                    amount: isLast ? perWeek + residual : perWeek,
                    status: 'pending',
                },
            });
        }

        this.logger.log(`Planificados ${weeks.length} payouts semanales para service virtual ${serviceId}`);
        return weeks.length;
    }

    /**
     * Crea una preference de MP para UNA VideoSession puntual (scheme
     * per_session). Solo la familia dueña del servicio puede pagarla. La
     * sesión tiene que estar `pending` de pago y el service asociado debe
     * tener scheme = per_session.
     *
     * Retorna el init_point para que el frontend redirija o abra el MP.
     */
    async createCheckoutForVideoSession(videoSessionId: string, familyUserId: string) {
        const session = await this.prisma.videoSession.findUnique({
            where: { id: videoSessionId },
        });
        if (!session) throw new NotFoundException('VideoSession no encontrada');
        if (session.status === 'cancelled') {
            throw new BadRequestException('Esta sesión está cancelada');
        }
        if (session.paymentStatus === 'retenido' || session.paymentStatus === 'released') {
            throw new BadRequestException('Esta sesión ya está paga');
        }

        const service = await this.prisma.service.findUnique({
            where: { id: session.serviceId },
            include: {
                family: { include: { user: true } },
                caregiver: { include: { user: true } },
            },
        });
        if (!service) throw new NotFoundException('Service not found');
        if (service.family.userId !== familyUserId) {
            throw new ForbiddenException('No sos el titular de este servicio');
        }
        if (service.paymentScheme !== 'per_session') {
            throw new BadRequestException(
                'Este paquete tiene pago upfront; usá /payments/checkout/:serviceId',
            );
        }

        const caregiver = service.caregiver;
        if (!caregiver?.hourlyRate || caregiver.hourlyRate <= 0) {
            throw new BadRequestException('Caregiver hourly rate not set');
        }

        // Precio de esta sesión: tarifa del cuidador × duración de la sesión.
        const durationMin = Math.max(
            1,
            Math.round((session.endAt.getTime() - session.startAt.getTime()) / 60_000),
        );
        const serviceAmount = caregiver.hourlyRate * (durationMin / 60);
        const commissionFamily = serviceAmount * this.COMMISSION_RATE;
        const commissionCarer = serviceAmount * this.COMMISSION_RATE;
        const netAmount = serviceAmount - commissionCarer;
        const totalAmount = serviceAmount + commissionFamily;

        const preference = new Preference(this.mpClient);
        const startTxt = session.startAt.toLocaleString('es-AR', {
            timeZone: 'America/Argentina/Buenos_Aires',
            day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
        });
        const result = await preference.create({
            body: {
                items: [{
                    id: videoSessionId,
                    title: `Sesión virtual CHO — ${startTxt}`,
                    description: `${durationMin}min con ${caregiver.user.firstName || 'el profesional'}`,
                    quantity: 1,
                    unit_price: Math.round(totalAmount * 100) / 100,
                    currency_id: 'ARS',
                }],
                back_urls: {
                    success: `${this.frontendUrl}/family/services/${service.id}?payment=success`,
                    failure: `${this.frontendUrl}/family/services/${service.id}?payment=failure`,
                    pending: `${this.frontendUrl}/family/services/${service.id}?payment=pending`,
                },
                auto_return: 'approved',
                // Prefijo distingue en el webhook entre service y videoSession.
                external_reference: `vs:${videoSessionId}`,
                notification_url: `${this.configService.get('BACKEND_URL') || 'https://choback.bladelink.company'}/api/payments/webhook`,
                metadata: {
                    kind: 'video_session',
                    video_session_id: videoSessionId,
                    service_id: service.id,
                    family_user_id: familyUserId,
                },
            },
        });

        // Guardo preferenceId + amounts para reconciliar en el webhook.
        await this.prisma.videoSession.update({
            where: { id: videoSessionId },
            data: {
                mpPreferenceId: result.id,
                amount: serviceAmount,
                netAmount,
                commissionFamily,
            },
        });

        this.logger.log(
            `MP preference ${result.id} para VideoSession ${videoSessionId}, total: $${totalAmount}`,
        );

        return {
            preferenceId: result.id,
            initPoint: result.init_point,
            sandboxInitPoint: result.sandbox_init_point,
            totalAmount,
            breakdown: {
                serviceAmount,
                familyCommission: commissionFamily,
                carerCommission: commissionCarer,
                carerReceives: netAmount,
                total: totalAmount,
            },
        };
    }

    /**
     * Fallback para reconciliar el pago de una VideoSession cuando el
     * webhook de MP no llegó a tiempo (o se perdió). Busca en MP por
     * external_reference = `vs:<videoSessionId>` y, si hay un payment
     * aprobado, ejecuta la misma lógica que el webhook.
     *
     * Idempotente: si ya está marcada como retenido/released, no hace nada.
     */
    async confirmVideoSessionPayment(videoSessionId: string, familyUserId: string) {
        const session = await this.prisma.videoSession.findUnique({
            where: { id: videoSessionId },
        });
        if (!session) throw new NotFoundException('VideoSession no encontrada');

        // Validar ownership
        const service = await this.prisma.service.findUnique({
            where: { id: session.serviceId },
            include: { family: true },
        });
        if (!service) throw new NotFoundException('Service not found');
        if (service.family.userId !== familyUserId) {
            throw new ForbiddenException('No sos el titular de este servicio');
        }

        if (session.paymentStatus === 'retenido' || session.paymentStatus === 'released') {
            return { status: 'already_paid', paymentStatus: session.paymentStatus };
        }

        try {
            const response = await fetch(
                `https://api.mercadopago.com/v1/payments/search?external_reference=${encodeURIComponent('vs:' + videoSessionId)}&sort=date_created&criteria=desc`,
                {
                    headers: {
                        'Authorization': `Bearer ${this.configService.get('MP_ACCESS_TOKEN')}`,
                    },
                },
            );
            if (!response.ok) {
                this.logger.warn(`MP search failed: ${response.status}`);
                return { status: 'search_failed', paymentStatus: session.paymentStatus };
            }
            const data = await response.json();
            const approved = data.results?.find((p: any) => p.status === 'approved');
            if (!approved) {
                return { status: 'not_found', paymentStatus: session.paymentStatus };
            }
            await this.handleVideoSessionPaymentApproved(
                videoSessionId,
                approved.id.toString(),
                approved.payment_method_id || 'mercadopago',
                approved.transaction_amount,
            );
            return { status: 'confirmed', paymentStatus: 'retenido' };
        } catch (err) {
            this.logger.error(`confirmVideoSessionPayment error: ${(err as Error).message}`);
            return { status: 'error', paymentStatus: session.paymentStatus };
        }
    }

    /**
     * Callback del webhook cuando el pago de una VideoSession fue aprobado
     * (scheme `per_session`). Marca la sesión como `retenido`, notifica al
     * cuidador y a la familia (push + websocket), y deja un aviso para el
     * cuidador de que puede contar con ese ingreso.
     *
     * La liberación al cuidador ocurre cuando la sesión pasa a `completed`
     * — ahí el cron `settleReleasablePayouts` la transiciona a `releasable`
     * y Telegram avisa al admin.
     */
    private async handleVideoSessionPaymentApproved(
        videoSessionId: string,
        mpPaymentId: string,
        paymentMethod: string,
        transactionAmount: number | null | undefined,
    ) {
        const session = await this.prisma.videoSession.findUnique({
            where: { id: videoSessionId },
        });
        if (!session) {
            this.logger.warn(`Webhook: VideoSession ${videoSessionId} no existe`);
            return;
        }
        if (session.paymentStatus === 'retenido' || session.paymentStatus === 'released') {
            // Idempotencia — MP puede reenviar webhooks.
            return;
        }

        await this.prisma.videoSession.update({
            where: { id: videoSessionId },
            data: {
                paymentStatus: 'retenido',
                mpPaymentId,
            },
        });

        // Crear un ServicePayout por esta sesión con amount = netAmount,
        // status = pending. El cron de closeExpiredVideoSessions lo pasa a
        // releasable cuando la sesión queda completed.
        if (session.netAmount && session.netAmount > 0) {
            await this.prisma.servicePayout.create({
                data: {
                    serviceId: session.serviceId,
                    weekIndex: 0,
                    weekStartAt: session.startAt,
                    weekEndAt: session.endAt,
                    amount: session.netAmount,
                    status: 'pending',
                },
            });
        }

        const service = await this.prisma.service.findUnique({
            where: { id: session.serviceId },
            include: {
                family: { include: { user: true } },
                caregiver: { include: { user: true } },
            },
        });
        if (!service) return;

        if (service.family?.user) {
            this.matchingGateway.emitToUser(service.family.userId, 'payment-received', {
                serviceId: service.id,
                videoSessionId,
                amount: transactionAmount,
            });
        }
        if (service.caregiver?.user) {
            this.matchingGateway.emitToUser(service.caregiver.userId, 'payment-received', {
                serviceId: service.id,
                videoSessionId,
                amount: transactionAmount,
            });
        }
        this.logger.log(
            `VideoSession ${videoSessionId} pagada (MP ${mpPaymentId}, ${paymentMethod}, $${transactionAmount})`,
        );
    }

    /**
     * Handles MP payment webhook notifications
     */
    async handleWebhook(body: any) {
        this.logger.log(`MP Webhook received: ${JSON.stringify(body)}`);

        if (body.type === 'payment') {
            const paymentId = body.data?.id;
            if (!paymentId) return { status: 'ignored' };

            try {
                const paymentApi = new Payment(this.mpClient);
                const payment = await paymentApi.get({ id: paymentId });

                this.logger.log(`Payment ${paymentId}: status=${payment.status}, ref=${payment.external_reference}`);

                if (payment.status === 'approved' && payment.external_reference) {
                    // Pagos por sesión (per_session scheme) llegan con prefijo
                    // `vs:<videoSessionId>`. Los manejamos aparte y cortamos acá.
                    if (payment.external_reference.startsWith('vs:')) {
                        await this.handleVideoSessionPaymentApproved(
                            payment.external_reference.slice(3),
                            paymentId.toString(),
                            payment.payment_method_id || 'mercadopago',
                            payment.transaction_amount,
                        );
                        return { status: 'ok' };
                    }

                    const serviceId = payment.external_reference;

                    const service = await this.prisma.service.update({
                        where: { id: serviceId },
                        data: {
                            paymentStatus: 'retenido',
                            mpPaymentId: paymentId.toString(),
                            paymentMethod: payment.payment_method_id || 'mercadopago',
                        },
                        include: {
                            family: { include: { user: true } },
                            caregiver: { include: { user: true } },
                        },
                    });

                    // Planificar payouts (idempotente) — 1 para presencial, N para virtual.
                    this.planPayouts(serviceId).catch(e =>
                        this.logger.error(`planPayouts failed for service ${serviceId}`, e),
                    );

                    // Notify both parties via WebSocket
                    if (service.family?.user) {
                        this.matchingGateway.emitToUser(service.family.userId, 'payment-received', {
                            serviceId,
                            amount: payment.transaction_amount,
                        });
                    }
                    if (service.caregiver?.user) {
                        this.matchingGateway.emitToUser(service.caregiver.userId, 'payment-received', {
                            serviceId,
                            amount: payment.transaction_amount,
                        });

                        // Email caregiver: payment received, start service
                        if (service.caregiver.user.email) {
                            const caregiverName = service.caregiver.user.firstName || service.caregiver.user.name || 'Cuidador';
                            const familyName = service.family?.user?.name ||
                                `${service.family?.user?.firstName || ''} ${service.family?.user?.lastName || ''}`.trim() || 'Familia';
                            const serviceTypeName = this.getServiceTypeName(service.serviceType);
                            this.mailService.sendPaymentReceivedEmail(
                                service.caregiver.user.email, caregiverName,
                                {
                                    familyName,
                                    serviceType: serviceTypeName,
                                    amount: payment.transaction_amount || 0,
                                    serviceId,
                                },
                            ).catch(e => this.logger.error('Failed to send payment received email', e));
                        }
                    }

                    this.logger.log(`Payment approved for service ${serviceId}`);
                }
            } catch (err) {
                this.logger.error(`Error processing payment webhook: ${err.message}`, err.stack);
            }
        }

        return { status: 'ok' };
    }

    /**
     * Libera todos los payouts liberables (`releasable`) de un Service. Para
     * presenciales es el único payout. Para virtuales es de 1 a N según
     * cuántas semanas estén cumplidas.
     *
     * Mantiene el endpoint clásico `POST /payments/:serviceId/release` útil
     * para operar sobre un service entero sin pensar en payouts. Para liberar
     * una semana específica (virtual) usar `releasePayout(payoutId)`.
     */
    async releasePayment(serviceId: string) {
        const service = await this.prisma.service.findUnique({
            where: { id: serviceId },
            include: {
                caregiver: { include: { user: true } },
                family: { include: { user: true } },
            },
        });

        if (!service) throw new NotFoundException('Service not found');
        if (service.paymentStatus !== 'retenido') {
            throw new BadRequestException('Payment not in escrow');
        }

        const releasable = await this.prisma.servicePayout.findMany({
            where: { serviceId, status: 'releasable' },
            orderBy: { weekIndex: 'asc' },
        });
        if (releasable.length === 0) {
            throw new BadRequestException('No hay payouts liberables para este service');
        }

        let totalReleased = 0;
        const releasedAt = new Date();
        for (const payout of releasable) {
            await this.prisma.servicePayout.update({
                where: { id: payout.id },
                data: { status: 'released', releasedAt },
            });
            totalReleased += payout.amount;
        }

        // Si ya no queda ninguno pendiente/releasable, el Service queda como
        // 'released' a nivel global.
        const remaining = await this.prisma.servicePayout.count({
            where: { serviceId, status: { not: 'released' } },
        });
        if (remaining === 0) {
            await this.prisma.service.update({
                where: { id: serviceId },
                data: { paymentStatus: 'released', releasedAt },
            });
        }

        // Notificar al cuidador
        if (service.caregiver?.user) {
            this.matchingGateway.emitToUser(service.caregiver.userId, 'payment-released', {
                serviceId,
                netAmount: totalReleased,
            });
            if (service.caregiver.user.email) {
                await this.mailService.sendPaymentReleasedEmail(
                    service.caregiver.user.email,
                    service.caregiver.user.firstName || service.caregiver.user.name || 'Cuidador',
                    totalReleased,
                    serviceId,
                );
            }
        }

        this.logger.log(
            `Released ${releasable.length} payout(s) for service ${serviceId}: $${totalReleased}`,
        );
        return {
            status: 'released',
            releasedCount: releasable.length,
            netAmount: totalReleased,
            serviceFullyReleased: remaining === 0,
            releasedAt,
        };
    }

    /**
     * Libera un payout específico (admin). Útil para virtuales donde el admin
     * libera semana por semana según el aviso de Telegram.
     */
    async releasePayout(payoutId: string) {
        const payout = await this.prisma.servicePayout.findUnique({
            where: { id: payoutId },
        });
        if (!payout) throw new NotFoundException('Payout not found');
        if (payout.status === 'released') {
            throw new BadRequestException('Payout ya liberado');
        }
        if (payout.status !== 'releasable') {
            throw new BadRequestException('Payout no está en estado releasable');
        }

        const releasedAt = new Date();
        await this.prisma.servicePayout.update({
            where: { id: payoutId },
            data: { status: 'released', releasedAt },
        });

        const service = await this.prisma.service.findUnique({
            where: { id: payout.serviceId },
            include: { caregiver: { include: { user: true } } },
        });

        const remaining = await this.prisma.servicePayout.count({
            where: { serviceId: payout.serviceId, status: { not: 'released' } },
        });
        if (remaining === 0 && service) {
            await this.prisma.service.update({
                where: { id: service.id },
                data: { paymentStatus: 'released', releasedAt },
            });
        }

        if (service?.caregiver?.user) {
            this.matchingGateway.emitToUser(service.caregiver.userId, 'payment-released', {
                serviceId: service.id,
                payoutId,
                weekIndex: payout.weekIndex,
                amount: payout.amount,
            });
            if (service.caregiver.user.email) {
                this.mailService.sendPaymentReleasedEmail(
                    service.caregiver.user.email,
                    service.caregiver.user.firstName || service.caregiver.user.name || 'Cuidador',
                    payout.amount,
                    service.id,
                ).catch(() => undefined);
            }
        }

        this.logger.log(
            `Released payout ${payoutId} (week ${payout.weekIndex}, $${payout.amount}) for service ${payout.serviceId}`,
        );
        return {
            status: 'released',
            amount: payout.amount,
            serviceFullyReleased: remaining === 0,
            releasedAt,
        };
    }

    /**
     * Confirm payment after MP redirect (fallback when webhook doesn't fire).
     * Searches for an approved payment by the preference's external_reference.
     */
    async confirmPayment(serviceId: string) {
        const service = await this.prisma.service.findUnique({
            where: { id: serviceId },
            include: {
                family: { include: { user: true } },
                caregiver: { include: { user: true } },
            },
        });

        if (!service) throw new NotFoundException('Service not found');

        // Already paid?
        if (service.paymentStatus === 'paid') {
            return { status: 'already_paid', paymentStatus: 'retenido' };
        }

        // If we have a preference ID, search for payments with that external_reference
        if (!service.mpPreferenceId) {
            return { status: 'no_preference', paymentStatus: service.paymentStatus };
        }

        try {
            // Search for payments with this service as external reference
            const response = await fetch(
                `https://api.mercadopago.com/v1/payments/search?external_reference=${serviceId}&sort=date_created&criteria=desc`,
                {
                    headers: {
                        'Authorization': `Bearer ${this.configService.get('MP_ACCESS_TOKEN')}`,
                    },
                },
            );

            if (!response.ok) {
                this.logger.warn(`MP search failed: ${response.status}`);
                return { status: 'search_failed', paymentStatus: service.paymentStatus };
            }

            const data = await response.json();
            const approvedPayment = data.results?.find((p: any) => p.status === 'approved');

            if (approvedPayment) {
                // Found an approved payment — update the service
                await this.prisma.service.update({
                    where: { id: serviceId },
                    data: {
                        paymentStatus: 'retenido',
                        mpPaymentId: approvedPayment.id.toString(),
                        paymentMethod: approvedPayment.payment_method_id || 'mercadopago',
                    },
                });

                // Planificar payouts (idempotente).
                this.planPayouts(serviceId).catch(e =>
                    this.logger.error(`planPayouts failed for service ${serviceId}`, e),
                );

                this.logger.log(`Payment confirmed via search for service ${serviceId}: MP payment ${approvedPayment.id}`);

                // Notify both parties
                if (service.family?.user) {
                    this.matchingGateway.emitToUser(service.family.userId, 'payment-received', {
                        serviceId,
                        amount: approvedPayment.transaction_amount,
                    });
                }
                if (service.caregiver?.user) {
                    this.matchingGateway.emitToUser(service.caregiver.userId, 'payment-received', {
                        serviceId,
                        amount: approvedPayment.transaction_amount,
                    });

                    if (service.caregiver.user.email) {
                        this.mailService.sendPaymentReceivedEmail(
                            service.caregiver.user.email,
                            service.caregiver.user.firstName || service.caregiver.user.name || 'Cuidador',
                            {
                                familyName: service.family?.user?.name || 'Familia',
                                serviceType: this.getServiceTypeName(service.serviceType),
                                amount: approvedPayment.transaction_amount || 0,
                                serviceId,
                            },
                        ).catch(() => { });
                    }
                }

                return { status: 'confirmed', paymentStatus: 'retenido' };
            }

            // Check for pending payment
            const pendingPayment = data.results?.find((p: any) => p.status === 'in_process' || p.status === 'pending');
            if (pendingPayment) {
                return { status: 'pending', paymentStatus: 'pending' };
            }

            return { status: 'not_found', paymentStatus: service.paymentStatus };
        } catch (err) {
            this.logger.error(`Error confirming payment: ${err.message}`);
            return { status: 'error', paymentStatus: service.paymentStatus };
        }
    }

    /**
     * Get payment status for a service
     */
    async getPaymentStatus(serviceId: string) {
        const service = await this.prisma.service.findUnique({
            where: { id: serviceId },
            select: {
                id: true,
                amount: true,
                paymentStatus: true,
                paymentMethod: true,
                mpPaymentId: true,
                commissionFamily: true,
                commissionCarer: true,
                netAmount: true,
                releasedAt: true,
            },
        });

        if (!service) throw new NotFoundException('Service not found');
        return service;
    }

    /**
     * Get payment history for a user (family or caregiver)
     * Includes: paid/retenido/released services AND accepted/confirmed services pending payment
     *
     * Fuente de verdad del monto:
     *  1. Presencial / virtual upfront_full → Service.amount (congelado en createCheckout)
     *  2. Virtual per_session → suma de VideoSession.amount reales (lo que MP cobró)
     *  3. Pendiente de cobro → estimado con agreedHourlyRate (rate pactado al
     *     seleccionar el cuidador). NUNCA caemos a caregiver.hourlyRate vivo
     *     — eso mostraba montos distintos a lo efectivamente cobrado cuando
     *     el cuidador cambiaba su tarifa post-selección.
     */
    async getPaymentHistory(userId: string, role: 'family' | 'caregiver') {
        let services: any[];

        if (role === 'family') {
            const family = await this.prisma.family.findUnique({ where: { userId } });
            if (!family) return [];
            services = await this.prisma.service.findMany({
                where: {
                    familyId: family.id,
                    OR: [
                        { paymentStatus: { in: ['paid', 'retenido', 'released', 'pending'] } },
                        { status: { in: ['accepted', 'confirmed'] } },
                    ],
                },
                include: {
                    caregiver: {
                        select: { user: { select: { firstName: true, lastName: true, name: true } } },
                    },
                    // VideoSessions con amounts reales para servicios virtuales
                    // per_session. En upfront_full quedan todas con amount=null
                    // y la suma es 0 — en ese caso usamos Service.amount.
                    videoSessions: {
                        select: {
                            amount: true,
                            netAmount: true,
                            commissionFamily: true,
                            paymentStatus: true,
                        },
                    },
                    reviews: { select: { rating: true, comment: true, reviewType: true, createdAt: true } },
                },
                orderBy: { updatedAt: 'desc' },
            });
        } else {
            const caregiver = await this.prisma.caregiver.findUnique({ where: { userId } });
            if (!caregiver) return [];
            services = await this.prisma.service.findMany({
                where: {
                    caregiverId: caregiver.id,
                    OR: [
                        { paymentStatus: { in: ['paid', 'retenido', 'released', 'pending'] } },
                        { status: { in: ['accepted', 'confirmed'] } },
                    ],
                },
                include: {
                    family: { include: { user: { select: { firstName: true, lastName: true, name: true } } } },
                    videoSessions: {
                        select: {
                            amount: true,
                            netAmount: true,
                            commissionFamily: true,
                            paymentStatus: true,
                        },
                    },
                    reviews: { select: { rating: true, comment: true, reviewType: true, createdAt: true } },
                },
                orderBy: { updatedAt: 'desc' },
            });
        }

        return services.map(s => {
            // Descifrar campos sensibles — el resto del flow asume plaintext.
            const decrypted = this.encryption.decryptServiceFields(s);

            // Virtual per_session: hay VideoSessions con amounts concretos.
            // Sumamos lo que realmente pasó por MP y pisamos los aggregates
            // del service. Sessions sin amount (no pagadas todavía) no suman.
            const vss = decrypted.videoSessions as Array<{
                amount: number | null;
                netAmount: number | null;
                commissionFamily: number | null;
                paymentStatus: string;
            }> | undefined;
            const hasSessionAmounts = vss?.some((v) => v.amount && v.amount > 0);

            if (decrypted.modality === 'virtual' && decrypted.paymentScheme === 'per_session' && hasSessionAmounts) {
                const sum = (field: 'amount' | 'netAmount' | 'commissionFamily') =>
                    (vss || []).reduce((acc, v) => acc + (v[field] || 0), 0);
                decrypted.amount = sum('amount');
                decrypted.netAmount = sum('netAmount');
                decrypted.commissionFamily = sum('commissionFamily');
                decrypted.commissionCarer = decrypted.amount - decrypted.netAmount;
                return decrypted;
            }

            // Pendiente de checkout: estimar usando SOLO el rate pactado.
            // Si no hay rate pactado (service legacy sin agreedHourlyRate), no
            // estimamos — el UI muestra "Pendiente" o 0, pero nunca un monto
            // que pueda diferir del pactado.
            if (!decrypted.amount && decrypted.agreedHourlyRate) {
                const duration = decrypted.duration || 1;
                decrypted.amount = decrypted.agreedHourlyRate * duration;
                decrypted.estimatedAmount = true;
            }

            return decrypted;
        });
    }

    private getServiceTypeName(type: string): string {
        const types: Record<string, string> = {
            elderly_care: 'Cuidado de Ancianos', special_needs: 'Necesidades Especiales',
            alzheimers: 'Alzheimer', physical_therapy: 'Terapia Física',
            companionship: 'Compañía', personal_care: 'Cuidado Personal',
            medication_management: 'Medicamentos', dementia_care: 'Demencia',
            digital: 'Acompañamiento digital',
        };
        return types[type] || type;
    }
}

/**
 * Devuelve el inicio de la semana (lunes, 00:00:00.000) que contiene `date`.
 * Se usa para agrupar VideoSessions por semana calendar al planificar payouts.
 * Calcula en hora local del servidor (Argentina para el caso actual).
 */
export function startOfWeekMonday(date: Date): Date {
    const d = new Date(date);
    const dow = d.getDay(); // 0=dom, 1=lun, ...
    // Distancia al lunes anterior.
    const diff = (dow + 6) % 7;
    d.setDate(d.getDate() - diff);
    d.setHours(0, 0, 0, 0);
    return d;
}
