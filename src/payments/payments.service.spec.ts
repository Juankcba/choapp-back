import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BadRequestException } from '@nestjs/common';
import { PaymentsService, startOfWeekMonday } from './payments.service';
import { PrismaService } from '../prisma/prisma.service';
import { MatchingGateway } from '../matching/matching.gateway';
import { MailService } from '../mail/mail.service';
import { TelegramService } from '../telegram/telegram.service';

// Los tests no tocan MP ni DB real — solo prueban la lógica de payouts y el
// flujo de liberación. PaymentsService construye un MercadoPagoConfig en el
// constructor (requiere MP_ACCESS_TOKEN); lo satisfacemos con un valor dummy.

function buildModule(overrides: {
    service?: any;
    payoutCount?: number;
    videoSessions?: any[];
    payouts?: any[];
    singlePayout?: any;
}): Promise<{ svc: PaymentsService; prismaMock: any }> {
    const prismaMock: any = {
        service: {
            findUnique: jest.fn().mockResolvedValue(overrides.service ?? null),
            update: jest.fn().mockResolvedValue({}),
        },
        servicePayout: {
            count: jest.fn().mockResolvedValue(overrides.payoutCount ?? 0),
            create: jest.fn().mockResolvedValue({}),
            findMany: jest.fn().mockResolvedValue(overrides.payouts ?? []),
            findUnique: jest.fn().mockResolvedValue(overrides.singlePayout ?? null),
            update: jest.fn().mockResolvedValue({}),
        },
        videoSession: {
            findMany: jest.fn().mockResolvedValue(overrides.videoSessions ?? []),
        },
        caregiver: {
            findUnique: jest.fn(),
        },
    };

    const configMock: Partial<ConfigService> = {
        get: jest.fn((k: string) => {
            if (k === 'MP_ACCESS_TOKEN') return 'TEST-TOKEN';
            if (k === 'FRONTEND_URL') return 'https://cho.test';
            return undefined;
        }),
    };

    return Test.createTestingModule({
        providers: [
            PaymentsService,
            { provide: PrismaService, useValue: prismaMock },
            { provide: ConfigService, useValue: configMock },
            {
                provide: MatchingGateway,
                useValue: { emitToUser: jest.fn(), emitToCaregiver: jest.fn() },
            },
            {
                provide: MailService,
                useValue: {
                    sendPaymentReleasedEmail: jest.fn().mockResolvedValue(undefined),
                    sendPaymentReceivedEmail: jest.fn(),
                },
            },
            { provide: TelegramService, useValue: { sendLog: jest.fn() } },
        ],
    }).compile().then((module: TestingModule) => ({
        svc: module.get<PaymentsService>(PaymentsService),
        prismaMock,
    }));
}

describe('startOfWeekMonday', () => {
    it('snaps any weekday to the monday 00:00 of its week', () => {
        // Miércoles 15/04/2026
        const wed = new Date(2026, 3, 15, 14, 30);
        const m = startOfWeekMonday(wed);
        expect(m.getDay()).toBe(1); // lunes
        expect(m.getHours()).toBe(0);
        expect(m.getMinutes()).toBe(0);
        expect(m.getDate()).toBe(13); // lunes 13/04
    });

    it('maps a sunday to the previous monday', () => {
        const sun = new Date(2026, 3, 19, 23, 59);
        const m = startOfWeekMonday(sun);
        expect(m.getDay()).toBe(1);
        expect(m.getDate()).toBe(13);
    });

    it('returns the same date when input is already monday 00:00', () => {
        const mon = new Date(2026, 3, 13, 0, 0, 0, 0);
        const m = startOfWeekMonday(mon);
        expect(m.getTime()).toBe(mon.getTime());
    });
});

describe('PaymentsService.planPayouts', () => {
    it('creates a single payout with full netAmount for an in_person service', async () => {
        const { svc, prismaMock } = await buildModule({
            service: {
                id: 'svc-1',
                modality: 'in_person',
                netAmount: 20000,
            },
        });

        const created = await svc.planPayouts('svc-1');
        expect(created).toBe(1);
        expect(prismaMock.servicePayout.create).toHaveBeenCalledTimes(1);
        const arg = prismaMock.servicePayout.create.mock.calls[0][0].data;
        expect(arg).toMatchObject({
            serviceId: 'svc-1',
            weekIndex: 0,
            amount: 20000,
            status: 'pending',
        });
        expect(arg.weekStartAt).toBeUndefined();
    });

    it('is idempotent: returns 0 and skips if payouts already exist', async () => {
        const { svc, prismaMock } = await buildModule({
            service: { id: 'svc-1', modality: 'in_person', netAmount: 20000 },
            payoutCount: 1,
        });
        const created = await svc.planPayouts('svc-1');
        expect(created).toBe(0);
        expect(prismaMock.servicePayout.create).not.toHaveBeenCalled();
    });

    it('splits a virtual package into N weekly payouts based on VideoSession weeks', async () => {
        // Paquete 4 semanas × 2 sesiones/semana (miércoles y viernes a las 10)
        const sessions: { startAt: Date }[] = [];
        const base = new Date(2026, 3, 13, 10, 0); // lunes 13/04
        for (let week = 0; week < 4; week++) {
            // miércoles y viernes de cada semana
            const wed = new Date(base);
            wed.setDate(base.getDate() + week * 7 + 2);
            const fri = new Date(base);
            fri.setDate(base.getDate() + week * 7 + 4);
            sessions.push({ startAt: wed }, { startAt: fri });
        }

        const { svc, prismaMock } = await buildModule({
            service: { id: 'svc-v', modality: 'virtual', netAmount: 80000 },
            videoSessions: sessions,
        });

        const created = await svc.planPayouts('svc-v');
        expect(created).toBe(4);
        expect(prismaMock.servicePayout.create).toHaveBeenCalledTimes(4);

        const amounts = prismaMock.servicePayout.create.mock.calls.map(
            (c: any) => c[0].data.amount,
        );
        // 80000 / 4 = 20000 por semana, sin residual.
        expect(amounts).toEqual([20000, 20000, 20000, 20000]);

        const indices = prismaMock.servicePayout.create.mock.calls.map(
            (c: any) => c[0].data.weekIndex,
        );
        expect(indices).toEqual([0, 1, 2, 3]);

        // weekStartAt debe estar presente y ordenado ascendente.
        const starts = prismaMock.servicePayout.create.mock.calls.map(
            (c: any) => c[0].data.weekStartAt.getTime(),
        );
        expect(starts).toEqual([...starts].sort((a, b) => a - b));
    });

    it('absorbs rounding residue in the last weekly payout', async () => {
        // netAmount 100 / 3 semanas = 33.33; la última debe recibir 33.34 para
        // que la suma cierre en 100.
        const base = new Date(2026, 3, 13, 10, 0);
        const sessions = [
            { startAt: new Date(base.getTime()) },
            { startAt: new Date(base.getTime() + 7 * 24 * 60 * 60 * 1000) },
            { startAt: new Date(base.getTime() + 14 * 24 * 60 * 60 * 1000) },
        ];

        const { svc, prismaMock } = await buildModule({
            service: { id: 'svc-v', modality: 'virtual', netAmount: 100 },
            videoSessions: sessions,
        });

        await svc.planPayouts('svc-v');
        const amounts = prismaMock.servicePayout.create.mock.calls.map(
            (c: any) => c[0].data.amount,
        );
        const sum = amounts.reduce((a: number, b: number) => a + b, 0);
        expect(Math.round(sum * 100) / 100).toBe(100);
        // La última semana absorbe el residuo.
        expect(amounts[2]).toBeGreaterThanOrEqual(amounts[0]);
    });

    it('falls back to a single payout if a virtual service has no VideoSessions yet', async () => {
        const { svc, prismaMock } = await buildModule({
            service: { id: 'svc-v', modality: 'virtual', netAmount: 40000 },
            videoSessions: [],
        });
        const created = await svc.planPayouts('svc-v');
        expect(created).toBe(1);
        const arg = prismaMock.servicePayout.create.mock.calls[0][0].data;
        expect(arg.amount).toBe(40000);
        expect(arg.weekIndex).toBe(0);
    });
});

describe('PaymentsService.releasePayout', () => {
    it('releases a releasable payout and marks service as fully released when no more remain', async () => {
        const { svc, prismaMock } = await buildModule({
            singlePayout: {
                id: 'po-1',
                serviceId: 'svc-1',
                weekIndex: 0,
                amount: 20000,
                status: 'releasable',
            },
        });
        prismaMock.servicePayout.count = jest.fn().mockResolvedValue(0);
        prismaMock.service.findUnique = jest.fn().mockResolvedValue({
            id: 'svc-1',
            caregiver: { userId: 'u-cg', user: { email: 'cg@x.com', firstName: 'Ana' } },
        });

        const result = await svc.releasePayout('po-1');
        expect(result.status).toBe('released');
        expect(result.amount).toBe(20000);
        expect(result.serviceFullyReleased).toBe(true);
        expect(prismaMock.servicePayout.update).toHaveBeenCalledWith({
            where: { id: 'po-1' },
            data: expect.objectContaining({ status: 'released' }),
        });
        expect(prismaMock.service.update).toHaveBeenCalledWith({
            where: { id: 'svc-1' },
            data: expect.objectContaining({ paymentStatus: 'released' }),
        });
    });

    it('keeps the service in retenido when there are still pending payouts', async () => {
        const { svc, prismaMock } = await buildModule({
            singlePayout: {
                id: 'po-2',
                serviceId: 'svc-v',
                weekIndex: 1,
                amount: 20000,
                status: 'releasable',
            },
        });
        prismaMock.servicePayout.count = jest.fn().mockResolvedValue(2); // 2 pending
        prismaMock.service.findUnique = jest.fn().mockResolvedValue({
            id: 'svc-v',
            caregiver: null,
        });

        const result = await svc.releasePayout('po-2');
        expect(result.serviceFullyReleased).toBe(false);
        // El endpoint NO debe tocar Service.paymentStatus si aún quedan payouts.
        expect(prismaMock.service.update).not.toHaveBeenCalled();
    });

    it('rejects releasing a payout that is not in releasable state', async () => {
        const { svc } = await buildModule({
            singlePayout: {
                id: 'po-pending',
                status: 'pending',
            },
        });
        await expect(svc.releasePayout('po-pending')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects releasing an already-released payout', async () => {
        const { svc } = await buildModule({
            singlePayout: {
                id: 'po-done',
                status: 'released',
            },
        });
        await expect(svc.releasePayout('po-done')).rejects.toBeInstanceOf(BadRequestException);
    });
});
