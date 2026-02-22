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
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';

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
        private readonly mailService: MailService,
        private readonly prisma: PrismaService,
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

    @SubscribeMessage('join')
    handleJoin(
        @ConnectedSocket() client: Socket,
        @MessageBody() data: { serviceId: string; userId: string },
    ) {
        const roomId = `service_${data.serviceId}`;
        client.join(roomId);
        this.socketToUser.set(client.id, data.userId);

        if (!this.roomUsers.has(roomId)) {
            this.roomUsers.set(roomId, new Set());
        }
        this.roomUsers.get(roomId)!.add(data.userId);

        this.logger.log(`User ${data.userId} joined room ${roomId}`);
    }

    @SubscribeMessage('leave')
    handleLeave(
        @ConnectedSocket() client: Socket,
        @MessageBody() data: { serviceId: string },
    ) {
        const roomId = `service_${data.serviceId}`;
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
        data: { serviceId: string; senderId: string; content: string },
    ) {
        const message = await this.chatService.addMessage(
            data.serviceId,
            data.senderId,
            data.content,
        );

        const roomId = `service_${data.serviceId}`;
        this.server.to(roomId).emit('newMessage', message);

        // Check if the other party is online in this room, if not send email
        this.notifyOfflineParty(data.serviceId, data.senderId, data.content);

        return message;
    }

    @SubscribeMessage('typing')
    handleTyping(
        @ConnectedSocket() client: Socket,
        @MessageBody() data: { serviceId: string; userId: string },
    ) {
        client.to(`service_${data.serviceId}`).emit('userTyping', {
            userId: data.userId,
        });
    }

    /**
     * If the other user in the service chat is offline, send them an email
     */
    private async notifyOfflineParty(serviceId: string, senderId: string, content: string) {
        try {
            const service = await this.prisma.service.findUnique({
                where: { id: serviceId },
                include: {
                    family: { include: { user: { select: { id: true, email: true, firstName: true, name: true } } } },
                    caregiver: { include: { user: { select: { id: true, email: true, firstName: true, name: true } } } },
                },
            });

            if (!service) return;

            // Determine who to notify
            const familyUserId = service.family?.user?.id;
            const caregiverUserId = service.caregiver?.user?.id;

            let recipientEmail: string | undefined;
            let recipientName: string | undefined;
            let senderName = 'Usuario';

            if (senderId === familyUserId && caregiverUserId) {
                // Family sent message → check if caregiver is online
                const roomUsers = this.roomUsers.get(`service_${serviceId}`);
                if (roomUsers?.has(caregiverUserId)) return; // online, skip email
                recipientEmail = service.caregiver?.user?.email;
                recipientName = service.caregiver?.user?.name || service.caregiver?.user?.firstName || 'Cuidador';
                senderName = service.family?.user?.name || service.family?.user?.firstName || 'Familia';
            } else if (senderId === caregiverUserId && familyUserId) {
                // Caregiver sent message → check if family is online
                const roomUsers = this.roomUsers.get(`service_${serviceId}`);
                if (roomUsers?.has(familyUserId)) return; // online, skip email
                recipientEmail = service.family?.user?.email;
                recipientName = service.family?.user?.name || service.family?.user?.firstName || 'Familia';
                senderName = service.caregiver?.user?.name || service.caregiver?.user?.firstName || 'Cuidador';
            }

            if (recipientEmail && recipientName) {
                await this.mailService.sendChatNotificationEmail(
                    recipientEmail,
                    recipientName,
                    senderName,
                    content,
                    serviceId,
                );
                this.logger.log(`Sent chat email notification to ${recipientEmail}`);
            }
        } catch (err) {
            this.logger.error('Error sending chat email notification', err);
        }
    }
}
