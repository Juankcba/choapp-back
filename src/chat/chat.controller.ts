import { Controller, Get, Post, Body, Param, Req } from '@nestjs/common';
import { ChatService } from './chat.service';

@Controller('chat')
export class ChatController {
    constructor(private readonly chatService: ChatService) { }

    @Get(':serviceId')
    async getChat(@Param('serviceId') serviceId: string) {
        return this.chatService.getMessages(serviceId);
    }

    @Get(':serviceId/messages')
    async getChatMessages(@Param('serviceId') serviceId: string) {
        return this.chatService.getMessages(serviceId);
    }

    @Post(':serviceId/messages')
    async sendMessage(
        @Param('serviceId') serviceId: string,
        @Req() req: any,
        @Body() body: { content: string },
    ) {
        return this.chatService.addMessage(serviceId, req.user.userId, body.content);
    }

    @Post(':serviceId/read')
    async markAsRead(
        @Param('serviceId') serviceId: string,
        @Req() req: any,
    ) {
        return this.chatService.markAsRead(serviceId, req.user.userId);
    }
}
