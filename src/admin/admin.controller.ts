import {
    Controller,
    Get,
    Post,
    Param,
    Body,
    UseGuards,
    Query,
} from '@nestjs/common';
import { AdminService } from './admin.service';
import { MailService } from '../mail/mail.service';
import { PaymentsService } from '../payments/payments.service';
import { Roles } from '../auth/decorators';
import { RolesGuard } from '../auth/roles.guard';

@Controller('admin')
@UseGuards(RolesGuard)
@Roles('admin')
export class AdminController {
    constructor(
        private readonly adminService: AdminService,
        private readonly mailService: MailService,
        private readonly paymentsService: PaymentsService,
    ) { }

    @Get('stats')
    async getStats() {
        return this.adminService.getStats();
    }

    @Get('caregivers/pending')
    async getPendingCaregivers() {
        return this.adminService.getPendingCaregivers();
    }

    @Post('caregivers/:id/verify')
    async verifyCaregiver(
        @Param('id') id: string,
        @Body() body: { approved: boolean },
    ) {
        return this.adminService.verifyCaregiver(id, body.approved);
    }

    @Get('services/active')
    async getActiveServices() {
        return this.adminService.getActiveServices();
    }

    @Get('services/all')
    async getAllServices() {
        return this.adminService.getAllServices();
    }

    @Get('services/:id/chat')
    async getServiceChat(@Param('id') id: string) {
        return this.adminService.getServiceChat(id);
    }

    @Get('activity')
    async getActivityLog(@Query('limit') limit?: string) {
        return this.adminService.getActivityLog(parseInt(limit || '50'));
    }

    @Get('payments/stats')
    async getPaymentStats() {
        return this.adminService.getPaymentStats();
    }

    @Post('payments/:serviceId/release')
    async releasePayment(@Param('serviceId') serviceId: string) {
        return this.paymentsService.releasePayment(serviceId);
    }

    @Post('test-email')
    async sendTestEmail(@Body() body: { email: string }) {
        return this.mailService.sendTestEmail(body.email);
    }
}
