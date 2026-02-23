import { Module } from '@nestjs/common';
import { CronService } from './cron.service';
import { PrismaModule } from '../prisma/prisma.module';
import { MatchingModule } from '../matching/matching.module';

@Module({
    imports: [PrismaModule, MatchingModule],
    providers: [CronService],
})
export class CronModule { }
