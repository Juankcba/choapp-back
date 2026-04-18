import { createHash } from 'crypto';

/**
 * Deterministic coordinate jitter for privacy.
 * Offsets real coordinates by a pseudo-random but stable amount (seeded by caregiver id)
 * so the exact location never leaves the backend.
 *
 * - Same seed always produces the same jittered output (no flickering across requests).
 * - Different seeds produce independent offsets.
 * - Offset is bounded by `maxMeters`.
 */
export function jitterCoord(
    lat: number,
    lng: number,
    seed: string,
    maxMeters = 3000,
): { lat: number; lng: number } {
    // Two independent hash channels from the seed
    const hash = createHash('sha256').update(seed).digest();
    // Read two 32-bit unsigned ints and normalize to [0, 1)
    const r1 = hash.readUInt32BE(0) / 0xffffffff;
    const r2 = hash.readUInt32BE(4) / 0xffffffff;

    // Polar-coordinate offset: random angle, random radius (sqrt for uniform disk)
    const angle = r1 * 2 * Math.PI;
    const distance = Math.sqrt(r2) * maxMeters;

    // 1 degree of latitude ≈ 111_320 m; longitude scales with cos(lat)
    const dLat = (distance * Math.cos(angle)) / 111_320;
    const dLng = (distance * Math.sin(angle)) / (111_320 * Math.cos((lat * Math.PI) / 180));

    return {
        lat: +(lat + dLat).toFixed(5),
        lng: +(lng + dLng).toFixed(5),
    };
}
