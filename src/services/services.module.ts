import { Module } from '@nestjs/common';
import { ServicesService } from './services.service';
import { ServicesController } from './services.controller';
import { MatchingModule } from '../matching/matching.module';
import { UsersModule } from '../users/users.module';

@Module({
    imports: [MatchingModule, UsersModule],
    controllers: [ServicesController],
    providers: [ServicesService],
})
export class ServicesModule { }
