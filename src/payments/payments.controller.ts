import { Controller, Post, Get, Body, Param, Req, HttpCode } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { Roles, Public } from '../auth/decorators';

@Controller('payments')
export class PaymentsController {
    constructor(private readonly paymentsService: PaymentsService) { }

    @Post('checkout/:serviceId')
    @Roles('family')
    async createCheckout(
        @Param('serviceId') serviceId: string,
        @Req() req: any,
    ) {
        return this.paymentsService.createCheckout(serviceId, req.user.userId);
    }

    @Post('webhook')
    @Public()
    @HttpCode(200)
    async handleWebhook(@Body() body: any) {
        return this.paymentsService.handleWebhook(body);
    }

    @Post(':serviceId/release')
    @Roles('admin')
    async releasePayment(@Param('serviceId') serviceId: string) {
        return this.paymentsService.releasePayment(serviceId);
    }

    @Get(':serviceId/status')
    async getPaymentStatus(@Param('serviceId') serviceId: string) {
        return this.paymentsService.getPaymentStatus(serviceId);
    }

    @Post(':serviceId/confirm')
    async confirmPayment(@Param('serviceId') serviceId: string) {
        return this.paymentsService.confirmPayment(serviceId);
    }

    @Get('history/:role')
    async getPaymentHistory(@Param('role') role: string, @Req() req: any) {
        const validRole = role === 'caregiver' ? 'caregiver' : 'family';
        return this.paymentsService.getPaymentHistory(req.user.userId, validRole);
    }
}
