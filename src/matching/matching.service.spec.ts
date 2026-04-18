import { Test, TestingModule } from '@nestjs/testing';
import { MatchingService, SERVICE_RADIUS_KM } from './matching.service';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { MatchingGateway } from './matching.gateway';
import { UsersService } from '../users/users.service';
import { QueueService } from '../queue/queue.service';

// Buenos Aires reference point used to generate fixtures.
const BA_LAT = -34.6037;
const BA_LNG = -58.3816;

// Offset ~km to the north by shifting latitude. 1 degree of latitude ≈ 111.32 km.
function latOffsetKm(km: number): number {
    return km / 111.32;
}

function makeCaregiver(overrides: Partial<any>): any {
    return {
        id: 'cg-id',
        userId: 'user-id',
        isAvailable: true,
        activationStatus: 'active',
        verificationStatus: 'verified',
        locationLat: BA_LAT,
        locationLng: BA_LNG,
        serviceRadius: 5000, // deliberately small — should be ignored now
        specialties: [],
        rating: 4.5,
        user: { email: 'cg@example.com', firstName: 'Ana', lastName: 'Pérez', name: 'Ana Pérez' },
        ...overrides,
    };
}

describe('MatchingService.findNearbyCaregivers', () => {
    let service: MatchingService;
    let caregiversData: any[];

    beforeEach(async () => {
        caregiversData = [];

        const prismaMock = {
            caregiver: {
                findMany: jest.fn().mockImplementation(() => Promise.resolve(caregiversData)),
            },
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                MatchingService,
                { provide: PrismaService, useValue: prismaMock },
                { provide: MailService, useValue: {} },
                { provide: MatchingGateway, useValue: {} },
                { provide: UsersService, useValue: {} },
                { provide: QueueService, useValue: { enqueuePush: jest.fn(), enqueueEmail: jest.fn() } },
            ],
        }).compile();

        service = module.get<MatchingService>(MatchingService);
    });

    it('includes a caregiver at 29.9 km from the service', async () => {
        caregiversData = [
            makeCaregiver({
                id: 'near',
                userId: 'u-near',
                locationLat: BA_LAT + latOffsetKm(29.9),
                locationLng: BA_LNG,
            }),
        ];

        const result = await service.findNearbyCaregivers(BA_LAT, BA_LNG);
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('near');
        expect(result[0].distance).toBeLessThanOrEqual(SERVICE_RADIUS_KM);
    });

    it('excludes a caregiver at 30.5 km from the service', async () => {
        caregiversData = [
            makeCaregiver({
                id: 'far',
                userId: 'u-far',
                locationLat: BA_LAT + latOffsetKm(30.5),
                locationLng: BA_LNG,
            }),
        ];

        const result = await service.findNearbyCaregivers(BA_LAT, BA_LNG);
        expect(result).toHaveLength(0);
    });

    it('ignores a small caregiver.serviceRadius: still notified if within 30 km', async () => {
        // Caregiver has serviceRadius = 5 km but is 20 km away. Should be included
        // because the system uses a fixed 30 km radius.
        caregiversData = [
            makeCaregiver({
                id: 'has-small-radius',
                userId: 'u-small',
                locationLat: BA_LAT + latOffsetKm(20),
                locationLng: BA_LNG,
                serviceRadius: 5000,
            }),
        ];

        const result = await service.findNearbyCaregivers(BA_LAT, BA_LNG);
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('has-small-radius');
    });

    it('ignores a large caregiver.serviceRadius: not notified if beyond 30 km', async () => {
        // Caregiver has serviceRadius = 100 km but is 40 km away. Should NOT be
        // included — the fixed 30 km rule is authoritative.
        caregiversData = [
            makeCaregiver({
                id: 'has-large-radius',
                userId: 'u-large',
                locationLat: BA_LAT + latOffsetKm(40),
                locationLng: BA_LNG,
                serviceRadius: 100000,
            }),
        ];

        const result = await service.findNearbyCaregivers(BA_LAT, BA_LNG);
        expect(result).toHaveLength(0);
    });

    it('skips caregivers without a stored location', async () => {
        caregiversData = [
            makeCaregiver({ id: 'no-loc', locationLat: null, locationLng: null }),
        ];

        const result = await service.findNearbyCaregivers(BA_LAT, BA_LNG);
        expect(result).toHaveLength(0);
    });

    it('sorts results by ascending distance', async () => {
        caregiversData = [
            makeCaregiver({
                id: 'far',
                userId: 'u-far',
                locationLat: BA_LAT + latOffsetKm(25),
                locationLng: BA_LNG,
            }),
            makeCaregiver({
                id: 'close',
                userId: 'u-close',
                locationLat: BA_LAT + latOffsetKm(5),
                locationLng: BA_LNG,
            }),
            makeCaregiver({
                id: 'mid',
                userId: 'u-mid',
                locationLat: BA_LAT + latOffsetKm(15),
                locationLng: BA_LNG,
            }),
        ];

        const result = await service.findNearbyCaregivers(BA_LAT, BA_LNG);
        expect(result.map(r => r.id)).toEqual(['close', 'mid', 'far']);
    });

    it('filters by specialty when caregiver has specialties and serviceType is provided', async () => {
        caregiversData = [
            makeCaregiver({
                id: 'match',
                userId: 'u-match',
                locationLat: BA_LAT + latOffsetKm(10),
                locationLng: BA_LNG,
                specialties: ['elderly_care', 'companionship'],
            }),
            makeCaregiver({
                id: 'no-match',
                userId: 'u-no-match',
                locationLat: BA_LAT + latOffsetKm(12),
                locationLng: BA_LNG,
                specialties: ['physical_therapy'],
            }),
            makeCaregiver({
                id: 'no-specs',
                userId: 'u-no-specs',
                locationLat: BA_LAT + latOffsetKm(14),
                locationLng: BA_LNG,
                specialties: [],
            }),
        ];

        const result = await service.findNearbyCaregivers(BA_LAT, BA_LNG, 'elderly_care');
        const ids = result.map(r => r.id);
        expect(ids).toContain('match');
        expect(ids).toContain('no-specs'); // caregivers without specialties pass through
        expect(ids).not.toContain('no-match');
    });
});
