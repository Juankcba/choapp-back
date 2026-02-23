import { Controller, Get, Post, Body, Param, Req, Query } from '@nestjs/common';
import { ChatService } from './chat.service';
import { ChatGateway } from './chat.gateway';

@Controller('chat')
export class ChatController {
    constructor(
        private readonly chatService: ChatService,
        private readonly chatGateway: ChatGateway,
    ) { }

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
     * Saves message and broadcasts via WebSocket so the web app gets it too
     */
    @Post(':serviceId/messages')
    async sendMessage(
        @Param('serviceId') serviceId: string,
        @Query('caregiverId') caregiverId: string,
        @Req() req: any,
        @Body() body: { content: string },
    ) {
        console.log('📨 Chat sendMessage:', { serviceId, caregiverId, userId: req.user?.userId, content: body.content?.substring(0, 20) });
        try {
            const result = await this.chatService.addMessage(serviceId, caregiverId, req.user.userId, body.content);

            // Broadcast via WebSocket so web clients in this room see the message
            const roomId = `chat_${serviceId}_${caregiverId}`;
            this.chatGateway.server.to(roomId).emit('newMessage', result);

            return result;
        } catch (error) {
            console.error('❌ Chat sendMessage error:', error);
            throw error;
        }
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
