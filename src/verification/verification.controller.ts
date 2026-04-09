import { Controller, Post, Get, Body, Req, RawBodyRequest } from '@nestjs/common';
import { VerificationService } from './verification.service';
import { Public } from '../auth/decorators';

@Controller('verification')
export class VerificationController {
    constructor(private readonly verificationService: VerificationService) { }

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
     * Webhook endpoint for Didit to send verification results
     * This is a public endpoint — Didit calls it directly
     */
    @Public()
    @Post('webhook')
    async handleWebhook(@Body() payload: any) {
        return this.verificationService.handleWebhook(payload);
    }
}
