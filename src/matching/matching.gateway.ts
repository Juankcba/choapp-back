import {
    WebSocketGateway,
    WebSocketServer,
    OnGatewayConnection,
    OnGatewayDisconnect,
    SubscribeMessage,
    ConnectedSocket,
    MessageBody,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';

@WebSocketGateway({
    cors: { origin: '*' },
    namespace: '/notifications',
})
export class MatchingGateway implements OnGatewayConnection, OnGatewayDisconnect {
    @WebSocketServer()
    server: Server;

    private readonly logger = new Logger(MatchingGateway.name);

    // Track online users: userId → Set<socketId>
    private onlineUsers = new Map<string, Set<string>>();
    // Reverse map: socketId → userId
    private socketToUser = new Map<string, string>();

    handleConnection(client: Socket) {
        this.logger.debug(`Client connected to /notifications: ${client.id}`);
    }

    handleDisconnect(client: Socket) {
        const userId = this.socketToUser.get(client.id);
        if (userId) {
            const sockets = this.onlineUsers.get(userId);
            if (sockets) {
                sockets.delete(client.id);
                if (sockets.size === 0) {
                    this.onlineUsers.delete(userId);
                    this.logger.log(`User ${userId} went offline`);
                }
            }
            this.socketToUser.delete(client.id);
        }
    }

    @SubscribeMessage('register')
    handleRegister(
        @ConnectedSocket() client: Socket,
        @MessageBody() data: { userId: string; role?: string },
    ) {
        const { userId } = data;
        if (!this.onlineUsers.has(userId)) {
            this.onlineUsers.set(userId, new Set());
        }
        this.onlineUsers.get(userId)!.add(client.id);
        this.socketToUser.set(client.id, userId);

        // Join personal room for targeted emissions
        client.join(`user_${userId}`);
        // Also join role-specific rooms
        if (data.role === 'caregiver') client.join(`caregiver_${userId}`);
        if (data.role === 'admin') client.join('admin_room');
        this.logger.log(`User ${userId} registered (socket: ${client.id}, role: ${data.role || 'unknown'})`);

        return { status: 'ok' };
    }

    /** Check if a user is currently online */
    isOnline(userId: string): boolean {
        return this.onlineUsers.has(userId) && this.onlineUsers.get(userId)!.size > 0;
    }

    /** Emit to any user (caregiver or family) */
    emitToUser(userId: string, event: string, data: any) {
        this.server.to(`user_${userId}`).emit(event, data);
        this.logger.log(`Emitted '${event}' to user ${userId}`);
    }

    /** Emit to a caregiver (alias for emitToUser) */
    emitToCaregiver(userId: string, event: string, data: any) {
        this.emitToUser(userId, event, data);
    }

    /** Get count of online users */
    getOnlineCount(): number {
        return this.onlineUsers.size;
    }

    /** Emit an event to all connected admins */
    emitToAdmins(event: string, data: any) {
        this.server.to('admin_room').emit(event, data);
        this.logger.log(`Emitted '${event}' to admin_room`);
    }
}
