import { Module } from '@nestjs/common';
import { VideoSessionsController } from './video-sessions.controller';
import { VideoSessionsService } from './video-sessions.service';
import { PrismaModule } from '../prisma/prisma.module';
import { MedixalinkModule } from '../medixalink/medixalink.module';

@Module({
    imports: [PrismaModule, MedixalinkModule],
    controllers: [VideoSessionsController],
    providers: [VideoSessionsService],
    exports: [VideoSessionsService],
})
export class VideoSessionsModule { }
