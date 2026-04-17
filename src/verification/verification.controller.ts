import { Controller, Post, Get, Body, Req, Res, Query, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { VerificationService } from './verification.service';
import { Public } from '../auth/decorators';

@Controller('verification')
export class VerificationController {
    private readonly logger = new Logger(VerificationController.name);

    constructor(
        private readonly verificationService: VerificationService,
        private readonly configService: ConfigService,
    ) { }

    /**
     * Get current identity verification status
     */
    @Get('status')
    async getStatus(@Req() req: any) {
        return this.verificationService.getStatus(req.user.userId);
    }

    /**
     * Create a new verification session (redirects user to Didit)
     */
    @Post('session')
    async createSession(
        @Req() req: any,
        @Body() body: { callbackUrl?: string },
    ) {
        return this.verificationService.createSession(req.user.userId, body.callbackUrl);
    }

    /**
     * Webhook endpoint for Didit to send verification results.
     * This is a public endpoint — Didit calls it directly (server-to-server POST).
     */
    @Public()
    @Post('webhook')
    async handleWebhook(@Body() payload: any) {
        return this.verificationService.handleWebhook(payload);
    }

    /**
     * Browser-facing redirect for Didit's success/cancel callback.
     * Didit (and the Flutter WebView) redirects the USER here as GET when
     * verification finishes. We process the result and bounce to the
     * public frontend so they don't see raw JSON.
     */
    @Public()
    @Get('webhook')
    async handleWebhookRedirect(
        @Query() query: Record<string, string>,
        @Res() res: Response,
    ) {
        const sessionId =
            query.verificationSessionId ||
            query.session_id ||
            query.sessionId ||
            query.session_token;
        const status = query.status;

        if (sessionId || status) {
            try {
                await this.verificationService.handleWebhook({
                    session_id: sessionId,
                    status,
                    vendor_data: query.vendor_data,
                });
            } catch (e) {
                this.logger.warn(`Failed to apply verification redirect: ${(e as Error).message}`);
            }
        }

        const frontendUrl =
            this.configService.get<string>('FRONTEND_URL') ||
            'https://cho.care';

        const result =
            status === 'Approved' || status === 'approved' || status === 'APPROVED'
                ? 'success'
                : status === 'Declined' || status === 'declined' || status === 'DECLINED'
                    ? 'error'
                    : 'pending';

        const redirectTo = `${frontendUrl.replace(/\/$/, '')}/verify-identity?verification=${result}${status ? `&status=${encodeURIComponent(status)}` : ''}`;
        return res.redirect(302, redirectTo);
    }
}
