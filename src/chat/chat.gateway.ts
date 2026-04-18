import {
    WebSocketGateway,
    WebSocketServer,
    SubscribeMessage,
    OnGatewayConnection,
    OnGatewayDisconnect,
    MessageBody,
    ConnectedSocket,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { ChatService } from './chat.service';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import { QueueService } from '../queue/queue.service';

// Preview length for the body of a chat push notification.
const CHAT_PUSH_PREVIEW_CHARS = 120;

@WebSocketGateway({
    cors: { origin: '*' },
    namespace: '/chat',
})
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
    @WebSocketServer()
    server: Server;

    private readonly logger = new Logger(ChatGateway.name);

    // Track users in chat rooms: roomId -> Set<userId>
    private roomUsers = new Map<string, Set<string>>();
    // Track socket -> userId mapping
    private socketToUser = new Map<string, string>();

    constructor(
        private readonly chatService: ChatService,
        private readonly prisma: PrismaService,
        private readonly usersService: UsersService,
        private readonly queueService: QueueService,
    ) { }

    handleConnection(client: Socket) {
        this.logger.debug(`Client connected to /chat: ${client.id}`);
    }

    handleDisconnect(client: Socket) {
        const userId = this.socketToUser.get(client.id);
        if (userId) {
            // Remove from all rooms
            for (const [roomId, users] of this.roomUsers.entries()) {
                users.delete(userId);
                if (users.size === 0) this.roomUsers.delete(roomId);
            }
            this.socketToUser.delete(client.id);
        }
        this.logger.debug(`Client disconnected from /chat: ${client.id}`);
    }

    /**
     * Join a 1v1 chat room: `chat_${serviceId}_${caregiverId}`
     */
    @SubscribeMessage('join')
    handleJoin(
        @ConnectedSocket() client: Socket,
        @MessageBody() data: { serviceId: string; caregiverId: string; userId: string },
    ) {
        const roomId = `chat_${data.serviceId}_${data.caregiverId}`;
        client.join(roomId);
        this.socketToUser.set(client.id, data.userId);

        if (!this.roomUsers.has(roomId)) {
            this.roomUsers.set(roomId, new Set());
        }
        this.roomUsers.get(roomId)!.add(data.userId);

        this.logger.log(`User ${data.userId} joined 1v1 room ${roomId}`);
    }

    @SubscribeMessage('leave')
    handleLeave(
        @ConnectedSocket() client: Socket,
        @MessageBody() data: { serviceId: string; caregiverId: string },
    ) {
        const roomId = `chat_${data.serviceId}_${data.caregiverId}`;
        client.leave(roomId);

        const userId = this.socketToUser.get(client.id);
        if (userId) {
            this.roomUsers.get(roomId)?.delete(userId);
        }
    }

    @SubscribeMessage('message')
    async handleMessage(
        @ConnectedSocket() client: Socket,
        @MessageBody()
        data: { serviceId: string; caregiverId: string; senderId: string; content: string },
    ) {
        const message = await this.chatService.addMessage(
            data.serviceId,
            data.caregiverId,
            data.senderId,
            data.content,
        );

        const roomId = `chat_${data.serviceId}_${data.caregiverId}`;
        this.server.to(roomId).emit('newMessage', message);

        // Push-notify the recipient if they are not actively in this room.
        // Email fallback for unread messages is handled by a separate cron (Fase 4).
        this.notifyRecipient(data.serviceId, data.caregiverId, data.senderId, data.content);

        return message;
    }

    @SubscribeMessage('typing')
    handleTyping(
        @ConnectedSocket() client: Socket,
        @MessageBody() data: { serviceId: string; caregiverId: string; userId: string },
    ) {
        client.to(`chat_${data.serviceId}_${data.caregiverId}`).emit('userTyping', {
            userId: data.userId,
        });
    }

    /**
     * Push-notify the recipient of a message if they are not in the 1v1 chat
     * room right now. If they are (foreground, same chat screen), they already
     * got the `newMessage` event and we stay silent to avoid double-notifying.
     *
     * Email fallback for still-unread messages is handled by an independent
     * cron (Fase 4) and intentionally not triggered here.
     */
    async notifyRecipient(serviceId: string, caregiverId: string, senderId: string, content: string) {
        try {
            const service = await this.prisma.service.findUnique({
                where: { id: serviceId },
                include: {
                    family: { include: { user: { select: { id: true, name: true, firstName: true } } } },
                    caregiver: { include: { user: { select: { id: true, name: true, firstName: true } } } },
                },
            });
            if (!service) return;

            const roomId = `chat_${serviceId}_${caregiverId}`;
            const familyUserId = service.family?.user?.id;
            const caregiverUserId = service.caregiver?.user?.id;

            let recipientUserId: string | undefined;
            let senderName = 'Usuario';

            if (senderId === familyUserId && caregiverUserId) {
                recipientUserId = caregiverUserId;
                senderName = service.family?.user?.name || service.family?.user?.firstName || 'Familia';
            } else if (senderId === caregiverUserId && familyUserId) {
                recipientUserId = familyUserId;
                senderName = service.caregiver?.user?.name || service.caregiver?.user?.firstName || 'Cuidador';
            }

            if (!recipientUserId) return;
            if (this.roomUsers.get(roomId)?.has(recipientUserId)) return;

            const preview = content.length > CHAT_PUSH_PREVIEW_CHARS
                ? `${content.slice(0, CHAT_PUSH_PREVIEW_CHARS).trimEnd()}…`
                : content;

            await this.queueService.enqueuePush(
                recipientUserId,
                `💬 ${senderName}`,
                preview,
                { type: 'chat', serviceId, caregiverId },
            );
        } catch (err) {
            this.logger.error('Error sending chat push notification', err);
        }
    }
}
