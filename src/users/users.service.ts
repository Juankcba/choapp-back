import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as admin from 'firebase-admin';

@Injectable()
export class UsersService {
    private readonly logger = new Logger(UsersService.name);

    constructor(private prisma: PrismaService) {
        // Initialize Firebase Admin if not already initialized
        if (!admin.apps.length) {
            admin.initializeApp({
                projectId: process.env.FIREBASE_PROJECT_ID || 'cho-app-6cd59',
            });
            this.logger.log('Firebase Admin initialized');
        }
    }

    async findById(id: string) {
        const user = await this.prisma.user.findUnique({ where: { id } });
        if (!user) throw new NotFoundException('User not found');
        const { password, ...result } = user;
        return result;
    }

    async updateProfile(id: string, data: any) {
        const user = await this.prisma.user.update({
            where: { id },
            data,
        });
        const { password, ...result } = user;
        return result;
    }

    /**
     * Add an FCM token to the user (replacing duplicates, max 5 tokens per user)
     */
    async addFcmToken(userId: string, token: string) {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: { fcmTokens: true },
        });
        if (!user) throw new NotFoundException('User not found');

        // Remove token if already exists (dedup) and add to end
        let tokens = (user.fcmTokens || []).filter(t => t !== token);
        tokens.push(token);
        // Keep only last 5 tokens (for multiple devices)
        if (tokens.length > 5) tokens = tokens.slice(-5);

        await this.prisma.user.update({
            where: { id: userId },
            data: { fcmTokens: tokens },
        });

        this.logger.log(`FCM token registered for user ${userId} (${tokens.length} tokens)`);
    }

    /**
     * Send a push notification to a user via Firebase Cloud Messaging
     */
    async sendPushToUser(userId: string, title: string, body: string, data?: Record<string, string>) {
        try {
            const user = await this.prisma.user.findUnique({
                where: { id: userId },
                select: { fcmTokens: true },
            });

            if (!user?.fcmTokens?.length) {
                this.logger.debug(`No FCM tokens for user ${userId}, skipping push`);
                return;
            }

            const message: admin.messaging.MulticastMessage = {
                tokens: user.fcmTokens,
                notification: { title, body },
                data: data || {},
                android: {
                    priority: 'high',
                    notification: {
                        sound: 'default',
                        channelId: 'cho_notifications',
                    },
                },
            };

            const response = await admin.messaging().sendEachForMulticast(message);
            this.logger.log(`Push sent to ${userId}: ${response.successCount}/${user.fcmTokens.length} delivered`);

            // Clean up invalid tokens
            if (response.failureCount > 0) {
                const invalidTokens: string[] = [];
                response.responses.forEach((resp, idx) => {
                    if (!resp.success && resp.error?.code === 'messaging/registration-token-not-registered') {
                        invalidTokens.push(user.fcmTokens[idx]);
                    }
                });
                if (invalidTokens.length > 0) {
                    const validTokens = user.fcmTokens.filter(t => !invalidTokens.includes(t));
                    await this.prisma.user.update({
                        where: { id: userId },
                        data: { fcmTokens: validTokens },
                    });
                    this.logger.log(`Cleaned ${invalidTokens.length} invalid FCM tokens for user ${userId}`);
                }
            }
        } catch (error) {
            this.logger.error(`Failed to send push to user ${userId}`, error);
        }
    }
}
