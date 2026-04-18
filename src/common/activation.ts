// Helpers to read the caregiver activation state during the verificationStatus →
// activationStatus transition. `verificationStatus` is the legacy field; new
// code must go through these helpers and never branch on it directly.

export type ActivationStatus = 'pending' | 'active' | 'suspended';

// Map the legacy verificationStatus values (verified|pending|rejected) to the
// new activationStatus (active|pending|suspended). Used both by the read
// helper below and by the one-shot migration script.
export function mapLegacyVerificationStatus(legacy: string | null | undefined): ActivationStatus {
    switch (legacy) {
        case 'verified':
            return 'active';
        case 'rejected':
            return 'suspended';
        case 'pending':
        default:
            return 'pending';
    }
}

// Return the caregiver's effective activation status. Prefers the new column;
// falls back to mapping the legacy one for docs that have not been migrated.
export function effectiveActivationStatus(caregiver: {
    activationStatus?: string | null;
    verificationStatus?: string | null;
}): ActivationStatus {
    // During transition, the column default is "pending". A doc that was
    // backfilled will have a non-default value that's authoritative.
    if (caregiver.activationStatus === 'active' || caregiver.activationStatus === 'suspended') {
        return caregiver.activationStatus;
    }
    // Doc not migrated yet OR freshly created → resolve from legacy.
    return mapLegacyVerificationStatus(caregiver.verificationStatus);
}

export function isActiveCaregiver(caregiver: {
    activationStatus?: string | null;
    verificationStatus?: string | null;
}): boolean {
    return effectiveActivationStatus(caregiver) === 'active';
}

// Map a target activationStatus back to its legacy mirror. Used by the admin
// endpoint when it writes both columns to keep old readers consistent.
export function legacyMirrorOf(status: ActivationStatus): 'pending' | 'verified' | 'rejected' {
    switch (status) {
        case 'active':
            return 'verified';
        case 'suspended':
            return 'rejected';
        case 'pending':
            return 'pending';
    }
}
