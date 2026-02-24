import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as admin from 'firebase-admin';
import * as path from 'path';
import * as fs from 'fs';

@Injectable()
export class UsersService {
    private readonly logger = new Logger(UsersService.name);

    constructor(private prisma: PrismaService) {
        // Initialize Firebase Admin if not already initialized
        if (!admin.apps.length) {
            try {
                const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
                    || path.resolve(process.cwd(), 'firebase-service-account.json');

                if (fs.existsSync(credPath)) {
                    const serviceAccount = JSON.parse(fs.readFileSync(credPath, 'utf8'));
                    admin.initializeApp({
                        credential: admin.credential.cert(serviceAccount),
                    });
                    this.logger.log('Firebase Admin initialized with service account credentials');
                } else {
                    admin.initializeApp({
                        projectId: process.env.FIREBASE_PROJECT_ID || 'cho-app-6cd59',
                    });
                    this.logger.warn('Firebase Admin initialized without credentials (push won\'t work)');
                }
            } catch (error) {
                this.logger.error('Failed to initialize Firebase Admin', error);
            }
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

            this.logger.log(`Sending push to ${userId} with ${user.fcmTokens.length} tokens: "${title}" — "${body}"`);

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
            this.logger.log(`Push result for ${userId}: ${response.successCount} success, ${response.failureCount} failed out of ${user.fcmTokens.length}`);

            // Log detailed per-token results
            response.responses.forEach((resp, idx) => {
                if (resp.success) {
                    this.logger.log(`  Token ${idx}: ✅ messageId=${resp.messageId}`);
                } else {
                    this.logger.error(`  Token ${idx}: ❌ code=${resp.error?.code} msg=${resp.error?.message}`);
                }
            });

            // Clean up invalid tokens
            if (response.failureCount > 0) {
                const invalidTokens: string[] = [];
                response.responses.forEach((resp, idx) => {
                    if (!resp.success && (
                        resp.error?.code === 'messaging/registration-token-not-registered' ||
                        resp.error?.code === 'messaging/invalid-registration-token'
                    )) {
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
            this.logger.error(`Failed to send push to user ${userId}:`, error?.message || error);
        }
    }
}
