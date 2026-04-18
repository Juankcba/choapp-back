import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { UsersModule } from '../users/users.module';
import { QueueService } from './queue.service';

@Global()
@Module({
    imports: [ConfigModule, UsersModule],
    providers: [QueueService],
    exports: [QueueService],
})
export class QueueModule { }
