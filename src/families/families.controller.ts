import { Controller, Get, Patch, Body, Req, UseGuards } from '@nestjs/common';
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

    @Patch('profile')
    @Roles('family')
    async updateProfile(@Req() req: any, @Body() body: any) {
        return this.familiesService.updateProfile(req.user.userId, body);
    }
}
