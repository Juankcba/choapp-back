import { Module } from '@nestjs/common';
import { ChatService } from './chat.service';
import { ChatController } from './chat.controller';
import { ChatGateway } from './chat.gateway';
import { MailModule } from '../mail/mail.module';

@Module({
    imports: [MailModule],
    controllers: [ChatController],
    providers: [ChatService, ChatGateway],
})
export class ChatModule { }
