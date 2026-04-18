import { Module } from '@nestjs/common';
import { VideoSessionsController } from './video-sessions.controller';
import { VideoSessionsService } from './video-sessions.service';
import { PrismaModule } from '../prisma/prisma.module';
import { MedixalinkModule } from '../medixalink/medixalink.module';
import { MatchingModule } from '../matching/matching.module';
import { QueueModule } from '../queue/queue.module';

@Module({
    imports: [PrismaModule, MedixalinkModule, MatchingModule, QueueModule],
    controllers: [VideoSessionsController],
    providers: [VideoSessionsService],
    exports: [VideoSessionsService],
})
export class VideoSessionsModule { }
