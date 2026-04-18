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
                // Priority 1: Inline JSON from env var (for Docker/cloud deployments)
                const inlineJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
                if (inlineJson) {
                    const serviceAccount = JSON.parse(inlineJson);
                    admin.initializeApp({
                        credential: admin.credential.cert(serviceAccount),
                    });
                    this.logger.log('Firebase Admin initialized from FIREBASE_SERVICE_ACCOUNT_JSON env var');
                } else {
                    // Priority 2: File path
                    const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
                        || path.resolve(process.cwd(), 'firebase-service-account.json');

                    if (fs.existsSync(credPath)) {
                        const serviceAccount = JSON.parse(fs.readFileSync(credPath, 'utf8'));
                        admin.initializeApp({
                            credential: admin.credential.cert(serviceAccount),
                        });
                        this.logger.log(`Firebase Admin initialized from file: ${credPath}`);
                    } else {
                        admin.initializeApp({
                            projectId: process.env.FIREBASE_PROJECT_ID || 'cho-app-6cd59',
                        });
                        this.logger.warn('Firebase Admin initialized WITHOUT credentials — push notifications will NOT work!');
                    }
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

    /**
     * Soft-delete the user account at the user's request (Ley 25.326 right
     * to erasure). We anonymize personally identifiable fields immediately
     * and flag `deletedAt`. A cron job runs the final purge 30 days later.
     *
     * The 30-day window exists because the operator (Nahuel monotributo)
     * needs to keep traceable invoices for fiscal audits and to let the
     * user change their mind before permanent destruction.
     */
    async requestAccountDeletion(userId: string): Promise<{ ok: true; deletedAt: string }> {
        const user = await this.prisma.user.findUnique({ where: { id: userId } });
        if (!user) throw new NotFoundException('User not found');
        if (user.deletedAt) {
            return { ok: true, deletedAt: user.deletedAt.toISOString() };
        }

        const now = new Date();
        const anonymizedEmail = `deleted-${userId}@cho.local`;

        await this.prisma.user.update({
            where: { id: userId },
            data: {
                deletedAt: now,
                isActive: false,
                // Anonymize identifying fields so the row is no longer
                // personally identifiable. Email is replaced with a unique
                // placeholder to preserve the @unique constraint.
                email: anonymizedEmail,
                firstName: null,
                lastName: null,
                name: 'Cuenta eliminada',
                phone: null,
                image: null,
                fcmTokens: [],
            },
        });

        this.logger.log(`User ${userId} requested account deletion. Soft-delete applied.`);
        return { ok: true, deletedAt: now.toISOString() };
    }

    async updateProfile(id: string, data: any) {
        const mapped: any = {};
        if (data.firstName !== undefined) mapped.firstName = data.firstName;
        if (data.lastName !== undefined) mapped.lastName = data.lastName;
        if (data.phone !== undefined) mapped.phone = data.phone;
        // Accept either `image` or `profileImage` from the client
        const image = data.image ?? data.profileImage;
        if (image !== undefined) mapped.image = image;
        // Keep `name` in sync with first+last when either changes
        if (data.firstName !== undefined || data.lastName !== undefined) {
            const current = await this.prisma.user.findUnique({
                where: { id },
                select: { firstName: true, lastName: true },
            });
            const first = data.firstName ?? current?.firstName ?? '';
            const last = data.lastName ?? current?.lastName ?? '';
            const composed = `${first} ${last}`.trim();
            if (composed) mapped.name = composed;
        }

        const user = await this.prisma.user.update({
            where: { id },
            data: mapped,
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
