import { Module } from '@nestjs/common';
import { ServicesService } from './services.service';
import { ServicesController } from './services.controller';
import { MatchingModule } from '../matching/matching.module';

@Module({
    imports: [MatchingModule],
    controllers: [ServicesController],
    providers: [ServicesService],
})
export class ServicesModule { }
