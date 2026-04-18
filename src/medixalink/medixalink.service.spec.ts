import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { InternalServerErrorException } from '@nestjs/common';
import { MedixalinkService, MEDIXALINK_PARTNER_ID } from './medixalink.service';

// fetch queda mockeado per-test; guardamos el original por si algún otro test
// del mismo runner lo usa.
const originalFetch = global.fetch;

describe('MedixalinkService', () => {
    let service: MedixalinkService;
    let fetchMock: jest.Mock;

    const envDefaults: Record<string, string> = {
        MEDIXALINK_AUTH_URL: 'https://auth.medixalink.test',
        MEDIXALINK_INTERNAL_API_KEY: 'test-key',
    };

    beforeEach(async () => {
        fetchMock = jest.fn();
        (global as any).fetch = fetchMock;

        const configMock: Partial<ConfigService> = {
            get: jest.fn((k: string) => envDefaults[k]),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                MedixalinkService,
                { provide: ConfigService, useValue: configMock },
            ],
        }).compile();

        service = module.get<MedixalinkService>(MedixalinkService);
    });

    afterAll(() => {
        (global as any).fetch = originalFetch;
    });

    it('posts to the partner-token endpoint with INTERNAL_API_KEY header and cho partnerId', async () => {
        fetchMock.mockResolvedValue({
            ok: true,
            json: async () => ({
                roomName: 'cho-abc123',
                videoDomain: 'video.medixalink.com',
                moderatorToken: 'mod-jwt',
                participantToken: 'part-jwt',
                expiresAt: '2026-04-18T14:30:00.000Z',
            }),
        });

        const result = await service.requestSessionTokens({
            sessionId: 'abc123',
            startAt: new Date('2026-04-18T13:00:00.000Z'),
            durationMin: 60,
            caregiver: { name: 'Ana Pérez', email: 'ana@example.com' },
            family: { name: 'Familia López', email: 'lopez@example.com' },
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://auth.medixalink.test/tools/telemedicine/partner-token');
        expect(init.method).toBe('POST');
        expect(init.headers['x-internal-api-key']).toBe('test-key');
        expect(init.headers['content-type']).toBe('application/json');

        const body = JSON.parse(init.body);
        expect(body.partnerId).toBe(MEDIXALINK_PARTNER_ID);
        expect(body.sessionId).toBe('abc123');
        expect(body.durationMin).toBe(60);
        expect(body.moderator).toEqual({ name: 'Ana Pérez', email: 'ana@example.com' });
        expect(body.participant).toEqual({ name: 'Familia López', email: 'lopez@example.com' });

        expect(result.roomName).toBe('cho-abc123');
        expect(result.moderatorToken).toBe('mod-jwt');
        expect(result.participantToken).toBe('part-jwt');
    });

    it('throws InternalServerError if MEDIXALINK_AUTH_URL is missing', async () => {
        (service as any).config.get = jest.fn((k: string) =>
            k === 'MEDIXALINK_AUTH_URL' ? undefined : 'test-key',
        );

        await expect(
            service.requestSessionTokens({
                sessionId: 'x',
                startAt: new Date(),
                durationMin: 30,
                caregiver: { name: 'A' },
                family: { name: 'B' },
            }),
        ).rejects.toBeInstanceOf(InternalServerErrorException);
    });

    it('throws InternalServerError if medixalink responds non-ok', async () => {
        fetchMock.mockResolvedValue({
            ok: false,
            status: 401,
            text: async () => 'Invalid or missing internal API key',
        });

        await expect(
            service.requestSessionTokens({
                sessionId: 'x',
                startAt: new Date(),
                durationMin: 30,
                caregiver: { name: 'A' },
                family: { name: 'B' },
            }),
        ).rejects.toBeInstanceOf(InternalServerErrorException);
    });

    it('throws if the response is missing tokens', async () => {
        fetchMock.mockResolvedValue({
            ok: true,
            json: async () => ({ roomName: 'cho-x' }), // sin tokens
        });

        await expect(
            service.requestSessionTokens({
                sessionId: 'x',
                startAt: new Date(),
                durationMin: 30,
                caregiver: { name: 'A' },
                family: { name: 'B' },
            }),
        ).rejects.toBeInstanceOf(InternalServerErrorException);
    });
});
