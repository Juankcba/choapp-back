import {
    Controller,
    Get,
    Post,
    Param,
    Body,
    UseGuards,
} from '@nestjs/common';
import { AdminService } from './admin.service';
import { Roles } from '../auth/decorators';
import { RolesGuard } from '../auth/roles.guard';

@Controller('admin')
@UseGuards(RolesGuard)
@Roles('admin')
export class AdminController {
    constructor(private readonly adminService: AdminService) { }

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
}
