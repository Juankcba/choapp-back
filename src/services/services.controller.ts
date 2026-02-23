import {
    Controller,
    Get,
    Post,
    Patch,
    Delete,
    Body,
    Param,
    Req,
    UseGuards,
} from '@nestjs/common';
import { ServicesService } from './services.service';
import { MatchingService } from '../matching/matching.service';
import { Roles } from '../auth/decorators';
import { RolesGuard } from '../auth/roles.guard';

@Controller('services')
@UseGuards(RolesGuard)
export class ServicesController {
    constructor(
        private readonly servicesService: ServicesService,
        private readonly matchingService: MatchingService,
    ) { }

    @Post()
    @Roles('family')
    async create(@Req() req: any, @Body() body: any) {
        return this.servicesService.create(req.user.userId, body);
    }

    @Get()
    @Roles('family')
    async findByFamily(@Req() req: any) {
        return this.servicesService.findByFamily(req.user.userId);
    }

    @Get('nearby')
    @Roles('caregiver')
    async getNearbyServices(@Req() req: any) {
        return this.servicesService.getNotificationsForCaregiver(req.user.userId);
    }

    @Get('interested')
    @Roles('caregiver')
    async getInterestedServices(@Req() req: any) {
        return this.servicesService.getInterestedForCaregiver(req.user.userId);
    }

    @Get('active')
    @Roles('caregiver')
    async getActiveServices(@Req() req: any) {
        return this.servicesService.findActiveForCaregiver(req.user.userId);
    }

    @Get(':id')
    async findById(@Param('id') id: string) {
        return this.servicesService.findById(id);
    }

    @Get(':id/candidates')
    @Roles('family')
    async getCandidates(@Param('id') id: string) {
        return this.servicesService.getInterestedCaregivers(id);
    }

    @Patch(':id')
    @Roles('family')
    async update(@Req() req: any, @Param('id') id: string, @Body() body: any) {
        return this.servicesService.update(req.user.userId, id, body);
    }

    @Delete(':id')
    @Roles('family')
    async remove(@Req() req: any, @Param('id') id: string) {
        return this.servicesService.remove(req.user.userId, id);
    }

    @Post(':id/respond')
    @Roles('caregiver')
    async respondToService(
        @Req() req: any,
        @Param('id') id: string,
        @Body() body: { accepted: boolean },
    ) {
        return this.servicesService.respondToService(req.user.userId, id, body.accepted);
    }

    @Post(':id/select')
    @Roles('family')
    async selectCaregiver(
        @Req() req: any,
        @Param('id') id: string,
        @Body() body: { caregiverId: string },
    ) {
        return this.servicesService.selectCaregiver(req.user.userId, id, body.caregiverId);
    }

    @Post(':id/start')
    @Roles('caregiver')
    async startService(@Req() req: any, @Param('id') id: string) {
        return this.servicesService.startService(req.user.userId, id);
    }

    @Post(':id/finish')
    @Roles('caregiver')
    async finishService(@Req() req: any, @Param('id') id: string) {
        return this.servicesService.finishService(req.user.userId, id);
    }
}
