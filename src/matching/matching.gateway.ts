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

    // Track online caregivers: userId → Set<socketId>
    private onlineCaregivers = new Map<string, Set<string>>();
    // Reverse map: socketId → userId
    private socketToUser = new Map<string, string>();

    handleConnection(client: Socket) {
        this.logger.debug(`Client connected to /notifications: ${client.id}`);
    }

    handleDisconnect(client: Socket) {
        const userId = this.socketToUser.get(client.id);
        if (userId) {
            const sockets = this.onlineCaregivers.get(userId);
            if (sockets) {
                sockets.delete(client.id);
                if (sockets.size === 0) {
                    this.onlineCaregivers.delete(userId);
                    this.logger.log(`Caregiver ${userId} went offline`);
                }
            }
            this.socketToUser.delete(client.id);
        }
    }

    @SubscribeMessage('register')
    handleRegister(
        @ConnectedSocket() client: Socket,
        @MessageBody() data: { userId: string },
    ) {
        const { userId } = data;
        if (!this.onlineCaregivers.has(userId)) {
            this.onlineCaregivers.set(userId, new Set());
        }
        this.onlineCaregivers.get(userId)!.add(client.id);
        this.socketToUser.set(client.id, userId);

        // Join personal room for targeted emissions
        client.join(`caregiver_${userId}`);
        this.logger.log(`Caregiver ${userId} registered (socket: ${client.id})`);

        return { status: 'ok' };
    }

    /**
     * Check if a caregiver is currently online
     */
    isOnline(userId: string): boolean {
        return this.onlineCaregivers.has(userId) && this.onlineCaregivers.get(userId)!.size > 0;
    }

    /**
     * Emit a new service notification to a specific caregiver
     */
    emitToCaregiver(userId: string, event: string, data: any) {
        this.server.to(`caregiver_${userId}`).emit(event, data);
        this.logger.log(`Emitted '${event}' to caregiver ${userId}`);
    }

    /**
     * Get count of online caregivers
     */
    getOnlineCount(): number {
        return this.onlineCaregivers.size;
    }
}
