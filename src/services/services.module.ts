import { Module } from '@nestjs/common';
import { ServicesService } from './services.service';
import { ServicesController } from './services.controller';
import { MatchingModule } from '../matching/matching.module';
import { UsersModule } from '../users/users.module';
import { VideoSessionsModule } from '../video-sessions/video-sessions.module';

@Module({
    imports: [MatchingModule, UsersModule, VideoSessionsModule],
    controllers: [ServicesController],
    providers: [ServicesService],
})
export class ServicesModule { }
