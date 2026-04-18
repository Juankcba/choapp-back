import {
    effectiveActivationStatus,
    isActiveCaregiver,
    legacyMirrorOf,
    mapLegacyVerificationStatus,
} from './activation';

describe('mapLegacyVerificationStatus', () => {
    it.each([
        ['verified', 'active'],
        ['rejected', 'suspended'],
        ['pending', 'pending'],
        [null, 'pending'],
        [undefined, 'pending'],
        ['garbage', 'pending'],
    ] as const)('maps %s → %s', (input, expected) => {
        expect(mapLegacyVerificationStatus(input as any)).toBe(expected);
    });
});

describe('effectiveActivationStatus', () => {
    it('prefers activationStatus=active even if legacy says pending (post-migration)', () => {
        expect(
            effectiveActivationStatus({ activationStatus: 'active', verificationStatus: 'pending' }),
        ).toBe('active');
    });

    it('prefers activationStatus=suspended over legacy verified', () => {
        expect(
            effectiveActivationStatus({ activationStatus: 'suspended', verificationStatus: 'verified' }),
        ).toBe('suspended');
    });

    it('falls back to legacy mapping when activationStatus is pending (not yet migrated)', () => {
        expect(
            effectiveActivationStatus({ activationStatus: 'pending', verificationStatus: 'verified' }),
        ).toBe('active');
    });

    it('falls back to legacy mapping when activationStatus is missing', () => {
        expect(
            effectiveActivationStatus({ verificationStatus: 'verified' }),
        ).toBe('active');
    });

    it('returns pending when both columns are pending', () => {
        expect(
            effectiveActivationStatus({ activationStatus: 'pending', verificationStatus: 'pending' }),
        ).toBe('pending');
    });

    it('treats a missing caregiver object as pending', () => {
        expect(effectiveActivationStatus({})).toBe('pending');
    });
});

describe('isActiveCaregiver', () => {
    it('is true for activationStatus=active', () => {
        expect(isActiveCaregiver({ activationStatus: 'active' })).toBe(true);
    });

    it('is true for not-yet-migrated docs whose legacy says verified', () => {
        expect(isActiveCaregiver({ verificationStatus: 'verified' })).toBe(true);
    });

    it('is false for suspended', () => {
        expect(isActiveCaregiver({ activationStatus: 'suspended', verificationStatus: 'rejected' })).toBe(false);
    });

    it('is false for plain pending', () => {
        expect(isActiveCaregiver({ activationStatus: 'pending', verificationStatus: 'pending' })).toBe(false);
    });
});

describe('legacyMirrorOf', () => {
    it.each([
        ['active', 'verified'],
        ['suspended', 'rejected'],
        ['pending', 'pending'],
    ] as const)('maps %s → %s', (input, expected) => {
        expect(legacyMirrorOf(input as any)).toBe(expected);
    });
});
