import { Test, TestingModule } from '@nestjs/testing';
import { CronService, UNREAD_EMAIL_DELAY_MS } from './cron.service';
import { PrismaService } from '../prisma/prisma.service';
import { MatchingService } from '../matching/matching.service';
import { TelegramService } from '../telegram/telegram.service';
import { MailService } from '../mail/mail.service';
import { QueueService } from '../queue/queue.service';

const FAMILY_USER_ID = 'user-family';
const CAREGIVER_USER_ID = 'user-caregiver';
const SERVICE_ID = 'service-1';
const CAREGIVER_PROFILE_ID = 'caregiver-1';
const CHAT_ID = 'chat-1';

function makeMessage(overrides: {
    senderId: string;
    minutesAgo: number;
    read?: boolean;
    notifiedByEmail?: boolean;
    content?: string;
}) {
    const ts = new Date(Date.now() - overrides.minutesAgo * 60 * 1000);
    return {
        senderId: overrides.senderId,
        senderName: 'x',
        content: overrides.content ?? 'Hola',
        timestamp: ts,
        read: overrides.read ?? false,
        notifiedByEmail: overrides.notifiedByEmail ?? false,
    };
}

function makeChat(messages: any[]) {
    return {
        id: CHAT_ID,
        serviceId: SERVICE_ID,
        caregiverId: CAREGIVER_PROFILE_ID,
        updatedAt: new Date(),
        messages,
        service: {
            id: SERVICE_ID,
            family: {
                user: {
                    id: FAMILY_USER_ID,
                    email: 'family@example.com',
                    name: 'Juana',
                    firstName: 'Juana',
                },
            },
            caregiver: {
                user: {
                    id: CAREGIVER_USER_ID,
                    email: 'caregiver@example.com',
                    name: 'Ana',
                    firstName: 'Ana',
                },
            },
        },
    };
}

describe('CronService.checkUnreadMessages', () => {
    let cron: CronService;
    let findMany: jest.Mock;
    let update: jest.Mock;
    let sendChatNotificationEmail: jest.Mock;

    beforeEach(async () => {
        findMany = jest.fn();
        update = jest.fn().mockResolvedValue(undefined);
        sendChatNotificationEmail = jest.fn().mockResolvedValue(undefined);

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                CronService,
                {
                    provide: PrismaService,
                    useValue: { chat: { findMany, update } },
                },
                { provide: MatchingService, useValue: {} },
                { provide: TelegramService, useValue: {} },
                { provide: MailService, useValue: { sendChatNotificationEmail } },
                { provide: QueueService, useValue: { enqueuePush: jest.fn(), enqueueEmail: jest.fn() } },
            ],
        }).compile();

        cron = module.get(CronService);
    });

    it('emails the caregiver when family sent a message 11 minutes ago that is still unread', async () => {
        findMany.mockResolvedValueOnce([
            makeChat([
                makeMessage({ senderId: FAMILY_USER_ID, minutesAgo: 11, content: '¿Estás ahí?' }),
            ]),
        ]);

        await cron.checkUnreadMessages();

        expect(sendChatNotificationEmail).toHaveBeenCalledTimes(1);
        const [email, recipientName, senderName, preview, serviceId] =
            sendChatNotificationEmail.mock.calls[0];
        expect(email).toBe('caregiver@example.com');
        expect(recipientName).toBe('Ana');
        expect(senderName).toBe('Juana');
        expect(preview).toBe('¿Estás ahí?');
        expect(serviceId).toBe(SERVICE_ID);

        // Flag should be set on the message after emailing.
        expect(update).toHaveBeenCalledTimes(1);
        const updatedMessages = update.mock.calls[0][0].data.messages;
        expect(updatedMessages[0].notifiedByEmail).toBe(true);
    });

    it('does NOT email messages that are under the delay threshold', async () => {
        findMany.mockResolvedValueOnce([
            makeChat([
                makeMessage({ senderId: FAMILY_USER_ID, minutesAgo: 5 }),
            ]),
        ]);

        await cron.checkUnreadMessages();

        expect(sendChatNotificationEmail).not.toHaveBeenCalled();
        expect(update).not.toHaveBeenCalled();
    });

    it('skips messages already flagged notifiedByEmail=true', async () => {
        findMany.mockResolvedValueOnce([
            makeChat([
                makeMessage({ senderId: FAMILY_USER_ID, minutesAgo: 30, notifiedByEmail: true }),
            ]),
        ]);

        await cron.checkUnreadMessages();

        expect(sendChatNotificationEmail).not.toHaveBeenCalled();
    });

    it('skips messages already read', async () => {
        findMany.mockResolvedValueOnce([
            makeChat([
                makeMessage({ senderId: FAMILY_USER_ID, minutesAgo: 30, read: true }),
            ]),
        ]);

        await cron.checkUnreadMessages();

        expect(sendChatNotificationEmail).not.toHaveBeenCalled();
    });

    it('skips messages older than the 24h lookback window', async () => {
        findMany.mockResolvedValueOnce([
            makeChat([
                makeMessage({ senderId: FAMILY_USER_ID, minutesAgo: 60 * 25 }),
            ]),
        ]);

        await cron.checkUnreadMessages();

        expect(sendChatNotificationEmail).not.toHaveBeenCalled();
    });

    it('groups multiple unread messages from the same sender into one email', async () => {
        findMany.mockResolvedValueOnce([
            makeChat([
                makeMessage({ senderId: FAMILY_USER_ID, minutesAgo: 30, content: 'Hola' }),
                makeMessage({ senderId: FAMILY_USER_ID, minutesAgo: 20, content: '¿Me escuchás?' }),
                makeMessage({ senderId: FAMILY_USER_ID, minutesAgo: 15, content: '¿Podés venir antes?' }),
            ]),
        ]);

        await cron.checkUnreadMessages();

        expect(sendChatNotificationEmail).toHaveBeenCalledTimes(1);
        const preview = sendChatNotificationEmail.mock.calls[0][3];
        expect(preview).toContain('3 mensajes nuevos');
        expect(preview).toContain('¿Podés venir antes?'); // last message used as preview

        // All three should be flagged.
        const updatedMessages = update.mock.calls[0][0].data.messages;
        expect(updatedMessages.every((m: any) => m.notifiedByEmail === true)).toBe(true);
    });

    it('sends separate emails when both parties have unread messages in the same chat', async () => {
        findMany.mockResolvedValueOnce([
            makeChat([
                makeMessage({ senderId: FAMILY_USER_ID, minutesAgo: 30, content: 'Hola' }),
                makeMessage({ senderId: CAREGIVER_USER_ID, minutesAgo: 20, content: 'Llegando' }),
            ]),
        ]);

        await cron.checkUnreadMessages();

        expect(sendChatNotificationEmail).toHaveBeenCalledTimes(2);
        const recipients = sendChatNotificationEmail.mock.calls.map((c) => c[0]);
        expect(recipients).toEqual(
            expect.arrayContaining(['caregiver@example.com', 'family@example.com']),
        );
    });

    it('does nothing for chats whose service has no assigned caregiver yet', async () => {
        const chat = makeChat([
            makeMessage({ senderId: FAMILY_USER_ID, minutesAgo: 30 }),
        ]);
        chat.service.caregiver = null as any;
        findMany.mockResolvedValueOnce([chat]);

        await cron.checkUnreadMessages();

        expect(sendChatNotificationEmail).not.toHaveBeenCalled();
    });

    it('leaves notifiedByEmail=false when the email send fails, so the next run retries', async () => {
        sendChatNotificationEmail.mockRejectedValueOnce(new Error('SMTP down'));
        findMany.mockResolvedValueOnce([
            makeChat([
                makeMessage({ senderId: FAMILY_USER_ID, minutesAgo: 30 }),
            ]),
        ]);

        await cron.checkUnreadMessages();

        expect(sendChatNotificationEmail).toHaveBeenCalledTimes(1);
        expect(update).not.toHaveBeenCalled();
    });

    it('uses the configured 10-minute delay threshold', () => {
        expect(UNREAD_EMAIL_DELAY_MS).toBe(10 * 60 * 1000);
    });
});
