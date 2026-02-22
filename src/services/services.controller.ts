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
import { Roles } from '../auth/decorators';
import { RolesGuard } from '../auth/roles.guard';

@Controller('services')
@UseGuards(RolesGuard)
export class ServicesController {
    constructor(private readonly servicesService: ServicesService) { }

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

    @Get(':id')
    async findById(@Param('id') id: string) {
        return this.servicesService.findById(id);
    }

    @Post(':id/accept')
    @Roles('family')
    async acceptCaregiver(@Req() req: any, @Param('id') id: string) {
        return this.servicesService.acceptService(id, req.user.userId);
    }
}
