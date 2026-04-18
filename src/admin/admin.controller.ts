import {
    Controller,
    Get,
    Post,
    Patch,
    Delete,
    Param,
    Body,
    UseGuards,
    Query,
    Req,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminService } from './admin.service';
import { MailService } from '../mail/mail.service';
import { PaymentsService } from '../payments/payments.service';
import { TestersService } from '../testers/testers.service';
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
        private readonly testersService: TestersService,
    ) { }

    // ─── User Management ─────────────────────────

    @Get('users')
    async getUsers(
        @Query('role') role?: string,
        @Query('isActive') isActive?: string,
        @Query('identityStatus') identityStatus?: string,
        @Query('search') search?: string,
    ) {
        return this.adminService.getUsers({ role, isActive, identityStatus, search });
    }

    @Get('users/:id')
    async getUserDetail(@Param('id') id: string) {
        return this.adminService.getUserDetail(id);
    }

    @Patch('users/:id/toggle-active')
    async toggleUserActive(@Param('id') id: string) {
        return this.adminService.toggleUserActive(id);
    }

    @Patch('users/:id/test-flag')
    async setTestAccountFlag(
        @Param('id') id: string,
        @Body() body: { isTestAccount: boolean },
    ) {
        return this.adminService.setTestAccountFlag(id, !!body.isTestAccount);
    }

    @Patch('users/:id/role')
    async updateUserRole(
        @Param('id') id: string,
        @Body() body: { role: string },
    ) {
        return this.adminService.updateUserRole(id, body.role);
    }

    @Patch('users/:id')
    async updateUser(
        @Param('id') id: string,
        @Body() body: {
            firstName?: string;
            lastName?: string;
            phone?: string;
            dni?: string;
            identityStatus?: string;
            address?: string;
        },
    ) {
        return this.adminService.updateUser(id, body);
    }

    // ─── Map Diagnostics ─────────────────────────

    @Get('map/bad-coords')
    async getBadCoords() {
        return this.adminService.getUsersWithBadCoordinates();
    }

    @Patch('caregivers/:id/clear-location')
    async clearCaregiverLocation(@Param('id') id: string) {
        return this.adminService.clearCaregiverLocation(id);
    }

    @Patch('families/:id/clear-location')
    async clearFamilyLocation(@Param('id') id: string) {
        return this.adminService.clearFamilyLocation(id);
    }

    @Patch('caregivers/:id/location')
    async updateCaregiverLocation(
        @Param('id') id: string,
        @Body() body: { lat: number; lng: number },
    ) {
        return this.adminService.updateCaregiverLocation(id, body.lat, body.lng);
    }

    @Patch('families/:id/location')
    async updateFamilyLocation(
        @Param('id') id: string,
        @Body() body: { lat: number; lng: number },
    ) {
        return this.adminService.updateFamilyLocation(id, body.lat, body.lng);
    }

    // ─── DNI / Identity ─────────────────────────

    @Get('users/:id/identity')
    async getUserIdentity(@Param('id') id: string) {
        return this.adminService.getUserIdentityDocuments(id);
    }

    // ─── Criminal Records ─────────────────────────

    @Get('users/:id/criminal-records')
    async getCriminalRecords(@Param('id') id: string) {
        return this.adminService.getCriminalRecords(id);
    }

    @Post('users/:id/criminal-records')
    async addCriminalRecord(
        @Param('id') id: string,
        @Body() body: {
            fileUrl: string;
            fileName: string;
            fileType: string;
            issueDate: string;
            expiresAt: string;
            notes?: string;
        },
        @Req() req: any,
    ) {
        const adminUserId = req.user?.userId || req.user?.sub || req.user?.id || 'unknown';
        return this.adminService.addCriminalRecord(id, { ...body, uploadedBy: adminUserId });
    }

    @Delete('criminal-records/:recordId')
    async deleteCriminalRecord(@Param('recordId') recordId: string) {
        return this.adminService.deleteCriminalRecord(recordId);
    }

    // ─── Testers ─────────────────────────

    @Get('testers')
    async getTesters(
        @Query('status') status?: string,
        @Query('device') device?: string,
        @Query('search') search?: string,
    ) {
        return this.testersService.getAll({ status, device, search });
    }

    @Get('testers/stats')
    async getTesterStats() {
        return this.testersService.getStats();
    }

    @Patch('testers/:id/status')
    async updateTesterStatus(
        @Param('id') id: string,
        @Body() body: { status: string; notes?: string; downloadLink?: string },
    ) {
        return this.testersService.updateStatus(id, body.status, body.notes, body.downloadLink);
    }

    // ─── Dashboard ─────────────────────────

    @Get('stats')
    async getStats() {
        return this.adminService.getStats();
    }

    @Get('caregivers/pending')
    async getPendingCaregivers() {
        return this.adminService.getPendingCaregivers();
    }

    @Post('caregivers/:id/activate')
    async activateCaregiver(@Param('id') id: string) {
        return this.adminService.setActivationStatus(id, 'active');
    }

    @Post('caregivers/:id/suspend')
    async suspendCaregiver(@Param('id') id: string) {
        return this.adminService.setActivationStatus(id, 'suspended');
    }

    /**
     * @deprecated legacy endpoint from the "verify professional" flow. Prefer
     * `activate` / `suspend`. Kept so the existing admin UI keeps working.
     */
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

    @Get('map-data')
    async getMapData() {
        return this.adminService.getMapData();
    }

    @Post('send-push')
    async sendPush(@Body() body: { userId: string; title: string; message: string }) {
        return this.adminService.sendPushNotification(body.userId, body.title, body.message);
    }
}
