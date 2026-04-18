import { Test, TestingModule } from '@nestjs/testing';
import { ChatGateway } from './chat.gateway';
import { ChatService } from './chat.service';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';

const SERVICE_ID = 'service-1';
const CAREGIVER_ID = 'caregiver-profile-1';
const FAMILY_USER_ID = 'user-family';
const CAREGIVER_USER_ID = 'user-caregiver';
const ROOM_ID = `chat_${SERVICE_ID}_${CAREGIVER_ID}`;

function makeServiceDoc() {
    return {
        id: SERVICE_ID,
        family: {
            user: { id: FAMILY_USER_ID, name: 'Juana', firstName: 'Juana' },
        },
        caregiver: {
            user: { id: CAREGIVER_USER_ID, name: 'Ana', firstName: 'Ana' },
        },
    };
}

describe('ChatGateway.notifyRecipient', () => {
    let gateway: ChatGateway;
    let sendPushToUser: jest.Mock;
    let findUnique: jest.Mock;

    beforeEach(async () => {
        sendPushToUser = jest.fn().mockResolvedValue(undefined);
        findUnique = jest.fn().mockResolvedValue(makeServiceDoc());

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                ChatGateway,
                { provide: ChatService, useValue: {} },
                { provide: PrismaService, useValue: { service: { findUnique } } },
                { provide: UsersService, useValue: { sendPushToUser } },
            ],
        }).compile();

        gateway = module.get(ChatGateway);
    });

    // Helper: mark a userId as "in the chat room" via the private roomUsers map.
    function putUserInRoom(userId: string) {
        const roomUsers = (gateway as unknown as { roomUsers: Map<string, Set<string>> }).roomUsers;
        if (!roomUsers.has(ROOM_ID)) roomUsers.set(ROOM_ID, new Set());
        roomUsers.get(ROOM_ID)!.add(userId);
    }

    it('pushes the caregiver when family sends and caregiver is NOT in the room', async () => {
        await gateway.notifyRecipient(SERVICE_ID, CAREGIVER_ID, FAMILY_USER_ID, 'Hola!');

        expect(sendPushToUser).toHaveBeenCalledTimes(1);
        const [userId, title, body, data] = sendPushToUser.mock.calls[0];
        expect(userId).toBe(CAREGIVER_USER_ID);
        expect(title).toContain('Juana');
        expect(body).toBe('Hola!');
        expect(data).toEqual({ type: 'chat', serviceId: SERVICE_ID, caregiverId: CAREGIVER_ID });
    });

    it('does NOT push when the recipient is already in the chat room', async () => {
        putUserInRoom(CAREGIVER_USER_ID);

        await gateway.notifyRecipient(SERVICE_ID, CAREGIVER_ID, FAMILY_USER_ID, 'Hola!');

        expect(sendPushToUser).not.toHaveBeenCalled();
    });

    it('pushes the family when caregiver sends and family is NOT in the room', async () => {
        await gateway.notifyRecipient(SERVICE_ID, CAREGIVER_ID, CAREGIVER_USER_ID, 'Llegando en 10 min');

        expect(sendPushToUser).toHaveBeenCalledTimes(1);
        expect(sendPushToUser.mock.calls[0][0]).toBe(FAMILY_USER_ID);
        expect(sendPushToUser.mock.calls[0][1]).toContain('Ana');
    });

    it('truncates long message previews with an ellipsis', async () => {
        const long = 'x'.repeat(300);

        await gateway.notifyRecipient(SERVICE_ID, CAREGIVER_ID, FAMILY_USER_ID, long);

        const body: string = sendPushToUser.mock.calls[0][2];
        expect(body.endsWith('…')).toBe(true);
        expect(body.length).toBeLessThanOrEqual(121);
    });

    it('does nothing if the service is not found', async () => {
        findUnique.mockResolvedValueOnce(null);

        await gateway.notifyRecipient(SERVICE_ID, CAREGIVER_ID, FAMILY_USER_ID, 'x');

        expect(sendPushToUser).not.toHaveBeenCalled();
    });

    it('does nothing if the caregiver side of the service has no user (no caregiver assigned yet)', async () => {
        findUnique.mockResolvedValueOnce({
            id: SERVICE_ID,
            family: { user: { id: FAMILY_USER_ID, name: 'Juana' } },
            caregiver: null,
        });

        await gateway.notifyRecipient(SERVICE_ID, CAREGIVER_ID, FAMILY_USER_ID, 'x');

        expect(sendPushToUser).not.toHaveBeenCalled();
    });

    it('swallows errors thrown by sendPushToUser (does not crash the socket handler)', async () => {
        sendPushToUser.mockRejectedValueOnce(new Error('FCM down'));

        await expect(
            gateway.notifyRecipient(SERVICE_ID, CAREGIVER_ID, FAMILY_USER_ID, 'x'),
        ).resolves.toBeUndefined();
    });
});
