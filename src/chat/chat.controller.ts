import { Controller, Get, Post, Body, Param, Req, Query } from '@nestjs/common';
import { ChatService } from './chat.service';

@Controller('chat')
export class ChatController {
    constructor(private readonly chatService: ChatService) { }

    /**
     * GET /chat/:serviceId/messages?caregiverId=XXX
     * Get messages for a 1v1 conversation
     */
    @Get(':serviceId/messages')
    async getChatMessages(
        @Param('serviceId') serviceId: string,
        @Query('caregiverId') caregiverId: string,
    ) {
        if (!caregiverId) return [];
        return this.chatService.getMessages(serviceId, caregiverId);
    }

    /**
     * GET /chat/:serviceId?caregiverId=XXX  (backwards compat)
     */
    @Get(':serviceId')
    async getChat(
        @Param('serviceId') serviceId: string,
        @Query('caregiverId') caregiverId: string,
    ) {
        if (!caregiverId) return [];
        return this.chatService.getMessages(serviceId, caregiverId);
    }

    /**
     * POST /chat/:serviceId/messages?caregiverId=XXX
     */
    @Post(':serviceId/messages')
    async sendMessage(
        @Param('serviceId') serviceId: string,
        @Query('caregiverId') caregiverId: string,
        @Req() req: any,
        @Body() body: { content: string },
    ) {
        return this.chatService.addMessage(serviceId, caregiverId, req.user.userId, body.content);
    }

    /**
     * POST /chat/:serviceId/read?caregiverId=XXX
     */
    @Post(':serviceId/read')
    async markAsRead(
        @Param('serviceId') serviceId: string,
        @Query('caregiverId') caregiverId: string,
        @Req() req: any,
    ) {
        return this.chatService.markAsRead(serviceId, caregiverId, req.user.userId);
    }
}
