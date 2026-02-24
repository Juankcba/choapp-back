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

        // Calculate amount from caregiver's hourly rate × service duration
        const caregiver = await this.prisma.caregiver.findUnique({ where: { id: service.caregiverId } });
        if (!caregiver?.hourlyRate || caregiver.hourlyRate <= 0) throw new BadRequestException('Caregiver hourly rate not set');

        const duration = service.duration || 1;
        const serviceAmount = caregiver.hourlyRate * duration;
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
                    description: `Cuidado para ${service.patientName || 'paciente'} - ${duration}hs`,
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
                            paymentStatus: 'retenido',
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
        if (service.paymentStatus !== 'retenido') throw new BadRequestException('Payment not in escrow');
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
     */
    async getPaymentHistory(userId: string, role: 'family' | 'caregiver') {
        if (role === 'family') {
            const family = await this.prisma.family.findUnique({ where: { userId } });
            if (!family) return [];
            return this.prisma.service.findMany({
                where: {
                    familyId: family.id,
                    OR: [
                        { paymentStatus: { in: ['paid', 'retenido', 'released', 'pending'] } },
                        { status: { in: ['accepted', 'confirmed'] } },
                    ],
                },
                include: {
                    caregiver: { include: { user: { select: { firstName: true, lastName: true, name: true } } } },
                    reviews: { select: { rating: true, comment: true, reviewType: true, createdAt: true } },
                },
                orderBy: { updatedAt: 'desc' },
            });
        } else {
            const caregiver = await this.prisma.caregiver.findUnique({ where: { userId } });
            if (!caregiver) return [];
            return this.prisma.service.findMany({
                where: {
                    caregiverId: caregiver.id,
                    OR: [
                        { paymentStatus: { in: ['paid', 'retenido', 'released', 'pending'] } },
                        { status: { in: ['accepted', 'confirmed'] } },
                    ],
                },
                include: {
                    family: { include: { user: { select: { firstName: true, lastName: true, name: true } } } },
                    reviews: { select: { rating: true, comment: true, reviewType: true, createdAt: true } },
                },
                orderBy: { updatedAt: 'desc' },
            });
        }
    }

    private getServiceTypeName(type: string): string {
        const types: Record<string, string> = {
            elderly_care: 'Cuidado de Ancianos', special_needs: 'Necesidades Especiales',
            alzheimers: 'Alzheimer', physical_therapy: 'Terapia Física',
            companionship: 'Compañía', personal_care: 'Cuidado Personal',
            medication_management: 'Medicamentos', dementia_care: 'Demencia',
        };
        return types[type] || type;
    }
}
