import {
    Body,
    Controller,
    Get,
    Param,
    Post,
    Query,
    Req,
    UseGuards,
} from '@nestjs/common';
import { VideoSessionsService } from './video-sessions.service';
import { Roles } from '../auth/decorators';
import { RolesGuard } from '../auth/roles.guard';

@Controller('video-sessions')
@UseGuards(RolesGuard)
export class VideoSessionsController {
    constructor(private readonly service: VideoSessionsService) { }

    /**
     * POST /video-sessions/materialize/:serviceId
     *
     * Se llama justo después de que la familia selecciona al cuidador para un
     * servicio virtual. Genera N turnos concretos para las próximas `weeks`
     * semanas (default 4). Idempotente.
     */
    @Post('materialize/:serviceId')
    @Roles('family', 'admin')
    async materialize(
        @Param('serviceId') serviceId: string,
        @Query('weeks') weeks?: string,
    ) {
        const weeksNum = weeks ? Math.max(1, Math.min(12, parseInt(weeks, 10))) : 4;
        return this.service.materializeForService(serviceId, { weeks: weeksNum });
    }

    /**
     * GET /video-sessions/mine
     *
     * Lista las sesiones próximas y recientes del usuario (familia o cuidador).
     */
    @Get('mine')
    @Roles('family', 'caregiver')
    async mine(@Req() req: any) {
        return this.service.listForUser(req.user.userId);
    }

    /**
     * GET /video-sessions/:id/join
     *
     * Devuelve `{ roomName, videoDomain, token, role, ... }` para abrir el
     * iframe de Jitsi. Solo se puede obtener dentro de la ventana
     * [startAt - 15min, endAt + 10min] y siendo parte de la sesión.
     */
    @Get(':id/join')
    @Roles('family', 'caregiver')
    async join(@Param('id') id: string, @Req() req: any) {
        return this.service.getJoinInfo(id, req.user.userId);
    }

    @Post(':id/cancel')
    @Roles('family', 'caregiver')
    async cancel(
        @Param('id') id: string,
        @Req() req: any,
        @Body('reason') reason?: string,
    ) {
        return this.service.cancel(id, req.user.userId, reason);
    }
}
