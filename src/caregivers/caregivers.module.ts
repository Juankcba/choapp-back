import { Module } from '@nestjs/common';
import { CaregiversService } from './caregivers.service';
import { CaregiversController } from './caregivers.controller';
import { MatchingModule } from '../matching/matching.module';

@Module({
    imports: [MatchingModule],
    controllers: [CaregiversController],
    providers: [CaregiversService],
})
export class CaregiversModule { }
