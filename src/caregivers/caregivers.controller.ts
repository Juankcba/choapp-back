import {
    Controller,
    Delete,
    Get,
    Patch,
    Post,
    Body,
    Param,
    Query,
    Req,
    UseGuards,
} from '@nestjs/common';
import { CaregiversService } from './caregivers.service';
import { Roles, Public } from '../auth/decorators';
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

    @Get(':id/public')
    @Public()
    async getPublicProfile(@Param('id') id: string) {
        return this.caregiversService.getPublicProfile(id);
    }

    /**
     * Perfil del cuidador para una familia que tiene relación con él. Se
     * diferencia de `/public` en que no filtra `isTestAccount` — útil para
     * cuentas de prueba que están interactuando en staging o en beta.
     * Valida ownership: solo retorna si la familia tiene ServiceNotification
     * o Service asignado con ese cuidador.
     */
    @Get(':id/for-family')
    @Roles('family')
    async getForFamily(@Param('id') id: string, @Req() req: any) {
        return this.caregiversService.getProfileForFamily(id, req.user.userId);
    }

    @Get('public/list')
    @Public()
    async getPublicList() {
        return this.caregiversService.getPublicList();
    }

    @Get('public/stats')
    @Public()
    async getPublicStats() {
        return this.caregiversService.getPublicStats();
    }

    @Get('public/search')
    @Public()
    async getPublicSearch(@Query('province') province?: string) {
        return this.caregiversService.getPublicSearch(province);
    }

    @Post('profile')
    @Roles('caregiver')
    async createProfile(@Req() req: any, @Body() body: any) {
        return this.caregiversService.updateProfile(req.user.userId, body);
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

    @Post('credentials')
    @Roles('caregiver')
    async addCredential(@Req() req: any, @Body() body: any) {
        return this.caregiversService.addCredential(req.user.userId, body);
    }

    @Delete('credentials/:id')
    @Roles('caregiver')
    async deleteCredential(@Req() req: any, @Param('id') id: string) {
        return this.caregiversService.deleteCredential(req.user.userId, id);
    }
}
