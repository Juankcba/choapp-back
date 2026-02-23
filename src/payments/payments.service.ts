import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { MatchingGateway } from '../matching/matching.gateway';
import { MailService } from '../mail/mail.service';
import { MercadoPagoConfig, Preference, Payment } from 'mercadopago';

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
        if (!service.amount || service.amount <= 0) throw new BadRequestException('Service amount not set');

        const commissionFamily = service.amount * this.COMMISSION_RATE;
        const totalAmount = service.amount + commissionFamily;

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
                    description: `Cuidado para ${service.patientName || 'paciente'} - ${service.duration || 0}hs`,
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

        // Save preference ID to service
        await this.prisma.service.update({
            where: { id: serviceId },
            data: {
                mpPreferenceId: result.id,
                commissionFamily,
                commissionCarer: service.amount * this.COMMISSION_RATE,
                netAmount: service.amount - (service.amount * this.COMMISSION_RATE),
            },
        });

        this.logger.log(`Created MP preference ${result.id} for service ${serviceId}, total: $${totalAmount}`);

        return {
            preferenceId: result.id,
            initPoint: result.init_point,
            sandboxInitPoint: result.sandbox_init_point,
            totalAmount,
            breakdown: {
                serviceAmount: service.amount,
                familyCommission: commissionFamily,
                total: totalAmount,
            },
        };
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
                    const serviceId = payment.external_reference;

                    const service = await this.prisma.service.update({
                        where: { id: serviceId },
                        data: {
                            paymentStatus: 'paid',
                            mpPaymentId: paymentId.toString(),
                            paymentMethod: payment.payment_method_id || 'mercadopago',
                        },
                        include: {
                            family: { include: { user: true } },
                            caregiver: { include: { user: true } },
                        },
                    });

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
     * Release payment to caregiver (admin action, after service completion)
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
        if (service.paymentStatus !== 'paid') throw new BadRequestException('Payment not yet received');
        if (service.status !== 'completed') throw new BadRequestException('Service not completed');

        const updated = await this.prisma.service.update({
            where: { id: serviceId },
            data: {
                paymentStatus: 'released',
                releasedAt: new Date(),
            },
        });

        // Notify caregiver
        if (service.caregiver?.user) {
            this.matchingGateway.emitToUser(service.caregiver.userId, 'payment-released', {
                serviceId,
                netAmount: service.netAmount,
            });

            // Send email
            if (service.caregiver.user.email) {
                await this.mailService.sendPaymentReleasedEmail(
                    service.caregiver.user.email,
                    service.caregiver.user.firstName || service.caregiver.user.name || 'Cuidador',
                    service.netAmount || 0,
                    serviceId,
                );
            }
        }

        this.logger.log(`Payment released for service ${serviceId}: $${service.netAmount}`);

        return {
            status: 'released',
            netAmount: service.netAmount,
            releasedAt: updated.releasedAt,
        };
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
}
