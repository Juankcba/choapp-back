import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker, JobsOptions, Job } from 'bullmq';
import IORedis, { Redis } from 'ioredis';
import { UsersService } from '../users/users.service';
import {
    EMAIL_QUEUE,
    EmailJobData,
    PUSH_QUEUE,
    PushJobData,
} from './queue.types';

const DEFAULT_JOB_OPTS: JobsOptions = {
    attempts: 5,
    backoff: { type: 'exponential', delay: 2_000 }, // 2s, 4s, 8s, 16s, 32s
    removeOnComplete: { age: 3_600 * 24, count: 5_000 }, // keep 24h / 5k latest
    removeOnFail: { age: 3_600 * 24 * 7 }, // keep failures 7 days
};

// Parameters for the in-process fallback when Redis is not configured.
// This mirrors BullMQ's retry shape but runs entirely in memory.
const INLINE_ATTEMPTS = 3;
const INLINE_BACKOFF_MS = 1_500; // exponential: 1.5s, 3s (two retries after first)

/**
 * Central queue service for resilient delivery of push notifications and
 * emails. Two modes:
 *
 *   - Redis mode: if REDIS_URL is set, jobs are enqueued on BullMQ with
 *     exponential retries. A worker process (in this same node) consumes them.
 *   - Inline mode: if no Redis is configured, enqueue* runs the job inline
 *     with a small retry loop. Same interface; lower resilience (a crash
 *     loses in-flight retries). Used as a deploy-safe default.
 */
@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(QueueService.name);
    private connection?: Redis;
    private pushQueue?: Queue<PushJobData>;
    private emailQueue?: Queue<EmailJobData>;
    private pushWorker?: Worker<PushJobData>;
    private emailWorker?: Worker<EmailJobData>;
    private readonly emailApiUrl: string;
    private readonly emailApiSecret: string;

    constructor(
        private readonly configService: ConfigService,
        private readonly usersService: UsersService,
    ) {
        const frontendUrl = this.configService.get<string>('FRONTEND_URL') || 'https://cho.bladelink.company';
        this.emailApiUrl = `${frontendUrl}/api/send-email`;
        this.emailApiSecret = this.configService.get<string>('EMAIL_API_SECRET') || 'cho-email-secret-2026';
    }

    onModuleInit() {
        const redisUrl = this.configService.get<string>('REDIS_URL');
        if (!redisUrl) {
            this.logger.warn('REDIS_URL not set — QueueService running in INLINE mode (no retries across restarts)');
            return;
        }

        try {
            this.connection = new IORedis(redisUrl, {
                maxRetriesPerRequest: null, // required by BullMQ workers
                enableReadyCheck: false,
            });
            this.connection.on('error', (err) => {
                this.logger.error(`Redis connection error: ${err.message}`);
            });

            this.pushQueue = new Queue<PushJobData>(PUSH_QUEUE, { connection: this.connection });
            this.emailQueue = new Queue<EmailJobData>(EMAIL_QUEUE, { connection: this.connection });

            this.pushWorker = new Worker<PushJobData>(
                PUSH_QUEUE,
                async (job: Job<PushJobData>) => this.processPushJob(job.data),
                { connection: this.connection, concurrency: 5 },
            );
            this.pushWorker.on('failed', (job, err) => {
                this.logger.error(`push job ${job?.id} failed: ${err.message}`);
            });

            this.emailWorker = new Worker<EmailJobData>(
                EMAIL_QUEUE,
                async (job: Job<EmailJobData>) => this.processEmailJob(job.data),
                { connection: this.connection, concurrency: 5 },
            );
            this.emailWorker.on('failed', (job, err) => {
                this.logger.error(`email job ${job?.id} failed: ${err.message}`);
            });

            this.logger.log('✅ QueueService running in REDIS mode');
        } catch (err) {
            this.logger.error(`Failed to initialize Redis queues, falling back to INLINE: ${(err as Error).message}`);
            this.connection = undefined;
            this.pushQueue = undefined;
            this.emailQueue = undefined;
        }
    }

    async onModuleDestroy() {
        await Promise.allSettled([
            this.pushWorker?.close(),
            this.emailWorker?.close(),
            this.pushQueue?.close(),
            this.emailQueue?.close(),
            this.connection?.quit(),
        ]);
    }

    /**
     * Enqueue a push notification. Returns immediately in both modes.
     */
    async enqueuePush(userId: string, title: string, body: string, data?: Record<string, string>): Promise<void> {
        const payload: PushJobData = { userId, title, body, data };
        if (this.pushQueue) {
            await this.pushQueue.add('send', payload, DEFAULT_JOB_OPTS);
            return;
        }
        this.runInline('push', () => this.processPushJob(payload));
    }

    /**
     * Enqueue an email send via the Vercel endpoint. Returns immediately.
     */
    async enqueueEmail(to: string, subject: string, html: string): Promise<void> {
        const payload: EmailJobData = { to, subject, html };
        if (this.emailQueue) {
            await this.emailQueue.add('send', payload, DEFAULT_JOB_OPTS);
            return;
        }
        this.runInline('email', () => this.processEmailJob(payload));
    }

    // ─────────────────────────────────────────────────────────
    // Job processors — called by BullMQ workers or inline runner
    // ─────────────────────────────────────────────────────────

    private async processPushJob(data: PushJobData): Promise<void> {
        await this.usersService.sendPushToUser(data.userId, data.title, data.body, data.data);
    }

    private async processEmailJob(data: EmailJobData): Promise<void> {
        const res = await fetch(this.emailApiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.emailApiSecret}`,
            },
            body: JSON.stringify({ to: data.to, subject: data.subject, html: data.html }),
        });
        if (!res.ok) {
            const err = await res.text();
            // Throwing lets BullMQ retry. In inline mode the runner catches.
            throw new Error(`Email API ${res.status}: ${err}`);
        }
    }

    // ─────────────────────────────────────────────────────────
    // Inline fallback: fire-and-forget with a small retry loop
    // ─────────────────────────────────────────────────────────

    private runInline(kind: string, task: () => Promise<void>): void {
        void (async () => {
            for (let attempt = 1; attempt <= INLINE_ATTEMPTS; attempt++) {
                try {
                    await task();
                    return;
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    if (attempt === INLINE_ATTEMPTS) {
                        this.logger.error(`${kind} inline job gave up after ${attempt} attempts: ${msg}`);
                        return;
                    }
                    const delay = INLINE_BACKOFF_MS * Math.pow(2, attempt - 1);
                    this.logger.warn(`${kind} inline job attempt ${attempt} failed (${msg}); retrying in ${delay}ms`);
                    await new Promise((r) => setTimeout(r, delay));
                }
            }
        })();
    }
}
