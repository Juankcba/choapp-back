import {
    Controller,
    Get,
    Post,
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
        // Get notifications for this caregiver
        return this.servicesService.getNotificationsForCaregiver(req.user.userId);
    }

    @Get(':id')
    async findById(@Param('id') id: string) {
        return this.servicesService.findById(id);
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

    @Post(':id/accept')
    @Roles('family')
    async acceptCaregiver(@Req() req: any, @Param('id') id: string) {
        return this.servicesService.acceptService(id, req.user.userId);
    }
}
