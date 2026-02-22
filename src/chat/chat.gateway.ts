import {
    WebSocketGateway,
    WebSocketServer,
    SubscribeMessage,
    OnGatewayConnection,
    OnGatewayDisconnect,
    MessageBody,
    ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { ChatService } from './chat.service';

@WebSocketGateway({
    cors: {
        origin: '*',
    },
    namespace: '/chat',
})
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
    @WebSocketServer()
    server: Server;

    private connectedUsers = new Map<string, string>(); // socketId -> userId

    constructor(private readonly chatService: ChatService) { }

    handleConnection(client: Socket) {
        console.log(`Client connected: ${client.id}`);
    }

    handleDisconnect(client: Socket) {
        this.connectedUsers.delete(client.id);
        console.log(`Client disconnected: ${client.id}`);
    }

    @SubscribeMessage('join')
    handleJoin(
        @ConnectedSocket() client: Socket,
        @MessageBody() data: { serviceId: string; userId: string },
    ) {
        client.join(`service_${data.serviceId}`);
        this.connectedUsers.set(client.id, data.userId);
        console.log(`User ${data.userId} joined room service_${data.serviceId}`);
    }

    @SubscribeMessage('leave')
    handleLeave(
        @ConnectedSocket() client: Socket,
        @MessageBody() data: { serviceId: string },
    ) {
        client.leave(`service_${data.serviceId}`);
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

        this.server
            .to(`service_${data.serviceId}`)
            .emit('newMessage', message);

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
}
