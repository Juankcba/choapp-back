import { Module } from '@nestjs/common';
import { ChatService } from './chat.service';
import { ChatController } from './chat.controller';
import { ChatGateway } from './chat.gateway';
import { UsersModule } from '../users/users.module';

@Module({
    imports: [UsersModule],
    controllers: [ChatController],
    providers: [ChatService, ChatGateway],
})
export class ChatModule { }
