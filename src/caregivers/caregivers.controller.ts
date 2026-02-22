import {
    Controller,
    Get,
    Patch,
    Post,
    Body,
    Param,
    Req,
    UseGuards,
} from '@nestjs/common';
import { CaregiversService } from './caregivers.service';
import { Roles } from '../auth/decorators';
import { RolesGuard } from '../auth/roles.guard';

@Controller('caregivers')
@UseGuards(RolesGuard)
export class CaregiversController {
    constructor(private readonly caregiversService: CaregiversService) { }

    @Get('profile')
    @Roles('caregiver')
    async getProfile(@Req() req: any) {
        return this.caregiversService.getProfile(req.user.userId);
    }

    @Patch('profile')
    @Roles('caregiver')
    async updateProfile(@Req() req: any, @Body() body: any) {
        return this.caregiversService.updateProfile(req.user.userId, body);
    }

    @Patch('availability')
    @Roles('caregiver')
    async updateAvailability(
        @Req() req: any,
        @Body() body: { isAvailable: boolean },
    ) {
        return this.caregiversService.updateAvailability(
            req.user.userId,
            body.isAvailable,
        );
    }

    @Get('jobs')
    @Roles('caregiver')
    async getJobs(@Req() req: any) {
        return this.caregiversService.getJobs(req.user.userId);
    }

    @Post('jobs/:id/accept')
    @Roles('caregiver')
    async acceptJob(@Req() req: any, @Param('id') id: string) {
        return this.caregiversService.acceptJob(req.user.userId, id);
    }

    @Post('jobs/:id/complete')
    @Roles('caregiver')
    async completeJob(@Req() req: any, @Param('id') id: string) {
        return this.caregiversService.completeJob(req.user.userId, id);
    }
}
