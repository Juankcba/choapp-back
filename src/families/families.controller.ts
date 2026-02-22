import { Controller, Get, Post, Patch, Body, Req, UseGuards } from '@nestjs/common';
import { FamiliesService } from './families.service';
import { Roles } from '../auth/decorators';
import { RolesGuard } from '../auth/roles.guard';

@Controller('families')
@UseGuards(RolesGuard)
export class FamiliesController {
    constructor(private readonly familiesService: FamiliesService) { }

    @Get('profile')
    @Roles('family')
    async getProfile(@Req() req: any) {
        return this.familiesService.getProfile(req.user.userId);
    }

    @Post('profile')
    @Roles('family')
    async createProfile(@Req() req: any, @Body() body: any) {
        return this.familiesService.updateProfile(req.user.userId, body);
    }

    @Patch('profile')
    @Roles('family')
    async updateProfile(@Req() req: any, @Body() body: any) {
        return this.familiesService.updateProfile(req.user.userId, body);
    }
}
