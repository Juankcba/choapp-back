import { Module } from '@nestjs/common';
import { CronService } from './cron.service';
import { PrismaModule } from '../prisma/prisma.module';
import { MatchingModule } from '../matching/matching.module';
import { QueueModule } from '../queue/queue.module';

@Module({
    imports: [PrismaModule, MatchingModule, QueueModule],
    providers: [CronService],
})
export class CronModule { }
