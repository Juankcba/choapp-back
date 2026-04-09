import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { MatchingGateway } from '../matching/matching.gateway';
import { UsersService } from '../users/users.service';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class VerificationService {
    private readonly logger = new Logger(VerificationService.name);
    private readonly apiKey: string;
    private readonly webhookSecret: string;
    private readonly workflowId: string;
    private readonly baseUrl = 'https://verification.didit.me';

    constructor(
        private prisma: PrismaService,
        private httpService: HttpService,
        private configService: ConfigService,
        private matchingGateway: MatchingGateway,
        private usersService: UsersService,
    ) {
        this.apiKey = this.configService.get<string>('DIDIT_API_KEY') || '';
        this.webhookSecret = this.configService.get<string>('DIDIT_WEBHOOK_SECRET') || '';
        this.workflowId = this.configService.get<string>('DIDIT_WORKFLOW_ID') || '';

        if (!this.apiKey) {
            this.logger.warn('DIDIT_API_KEY not configured — identity verification disabled');
        }
    }

    /**
     * Get identity verification status for a user
     */
    async getStatus(userId: string) {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: {
                identityStatus: true,
                dni: true,
                diditVerifiedAt: true,
            },
        });
        if (!user) throw new BadRequestException('User not found');

        return {
            status: user.identityStatus,
            dni: user.dni ? `${user.dni.slice(0, 2)}****${user.dni.slice(-2)}` : null,
            verifiedAt: user.diditVerifiedAt,
        };
    }

    /**
     * Create a Didit verification session for the user
     */
    async createSession(userId: string, callbackUrl?: string) {
        if (!this.apiKey || !this.workflowId) {
            throw new BadRequestException('Identity verification is not configured');
        }

        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: { identityStatus: true, email: true, firstName: true, lastName: true },
        });
        if (!user) throw new BadRequestException('User not found');

        if (user.identityStatus === 'verified') {
            throw new BadRequestException('Identity already verified');
        }

        try {
            const response = await firstValueFrom(
                this.httpService.post(
                    `${this.baseUrl}/v3/session/`,
                    {
                        workflow_id: this.workflowId,
                        vendor_data: userId,
                        callback: callbackUrl || undefined,
                    },
                    {
                        headers: {
                            'x-api-key': this.apiKey,
                            'Content-Type': 'application/json',
                        },
                    },
                ),
            );

            const { verification_url, session_token } = response.data;

            // Update user with session info
            await this.prisma.user.update({
                where: { id: userId },
                data: {
                    diditSessionId: session_token || response.data.session_id,
                    identityStatus: 'pending',
                },
            });

            this.logger.log(`Verification session created for user ${userId}`);

            return {
                verificationUrl: verification_url,
                sessionId: session_token || response.data.session_id,
            };
        } catch (error) {
            this.logger.error(`Failed to create Didit session for user ${userId}`, error?.response?.data || error.message);
            throw new BadRequestException('Could not create verification session. Please try again later.');
        }
    }

    /**
     * Handle webhook from Didit with verification results
     */
    async handleWebhook(payload: any) {
        this.logger.log(`Didit webhook received: ${JSON.stringify(payload)}`);

        const sessionId = payload.session_id || payload.session_token;
        const status = payload.status; // "Approved", "Declined", "In Progress"
        const vendorData = payload.vendor_data; // userId

        if (!vendorData && !sessionId) {
            this.logger.warn('Webhook missing vendor_data and session_id');
            return { received: true };
        }

        // Find user by vendorData (userId) or diditSessionId
        let user;
        if (vendorData) {
            user = await this.prisma.user.findUnique({ where: { id: vendorData } });
        }
        if (!user && sessionId) {
            user = await this.prisma.user.findFirst({ where: { diditSessionId: sessionId } });
        }

        if (!user) {
            this.logger.warn(`User not found for webhook. vendorData=${vendorData}, sessionId=${sessionId}`);
            return { received: true };
        }

        // Map Didit status to our status
        let identityStatus = user.identityStatus;
        if (status === 'Approved' || status === 'approved') {
            identityStatus = 'verified';
        } else if (status === 'Declined' || status === 'declined') {
            identityStatus = 'rejected';
        } else if (status === 'In Progress' || status === 'in_progress') {
            identityStatus = 'pending';
        }

        // Extract DNI from document data if available
        const dni = payload.document_number || payload.documents?.[0]?.document_number || null;

        const updateData: any = {
            identityStatus,
        };
        if (identityStatus === 'verified') {
            updateData.diditVerifiedAt = new Date();
        }
        if (dni) {
            updateData.dni = dni;
        }

        await this.prisma.user.update({
            where: { id: user.id },
            data: updateData,
        });

        this.logger.log(`User ${user.id} identity status updated to: ${identityStatus}`);

        // Notify user via WebSocket
        const isApproved = identityStatus === 'verified';
        this.matchingGateway.emitToUser(user.id, 'identity-verified', {
            status: identityStatus,
            message: isApproved
                ? '✅ ¡Tu identidad fue verificada exitosamente!'
                : '❌ Tu verificación de identidad fue rechazada. Por favor intentá de nuevo.',
        });

        // Push notification
        if (isApproved) {
            this.usersService.sendPushToUser(
                user.id,
                '✅ Identidad Verificada',
                '¡Tu identidad fue verificada! Ya podés usar todas las funcionalidades.',
                { type: 'identity-verified' },
            ).catch(e => this.logger.error('Push failed for identity verification', e));
        } else if (identityStatus === 'rejected') {
            this.usersService.sendPushToUser(
                user.id,
                '⚠️ Verificación Rechazada',
                'Tu verificación de identidad no pudo ser completada. Intentá de nuevo.',
                { type: 'identity-rejected' },
            ).catch(e => this.logger.error('Push failed for identity rejection', e));
        }

        return { received: true, status: identityStatus };
    }
}
