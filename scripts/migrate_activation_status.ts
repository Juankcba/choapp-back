/**
 * One-shot migration: copy the legacy `verificationStatus` over to the new
 * `activationStatus` column on every Caregiver, applying the mapping:
 *
 *   verificationStatus=verified  →  activationStatus=active
 *   verificationStatus=rejected  →  activationStatus=suspended
 *   verificationStatus=pending   →  activationStatus=pending
 *
 * Idempotent by design:
 *   - Skips docs that already have a non-pending `activationStatus`.
 *   - Running the script twice does not double-write or overwrite manual
 *     changes made after the first run.
 *
 * Dry-run by default; pass `--write` to actually update MongoDB.
 *
 * Usage:
 *   npx ts-node scripts/migrate_activation_status.ts           # dry run
 *   npx ts-node scripts/migrate_activation_status.ts --write   # apply
 */

import { PrismaClient } from '@prisma/client';
import { mapLegacyVerificationStatus } from '../src/common/activation';

const WRITE = process.argv.includes('--write');

async function main() {
    const prisma = new PrismaClient();
    try {
        const caregivers = await prisma.caregiver.findMany({
            select: {
                id: true,
                userId: true,
                activationStatus: true,
                verificationStatus: true,
            },
        });

        let toUpdate = 0;
        let alreadyOk = 0;
        let skipped = 0;

        console.log(`Scanned ${caregivers.length} caregivers.\n`);

        for (const cg of caregivers) {
            const target = mapLegacyVerificationStatus(cg.verificationStatus);

            // Already migrated explicitly — leave alone.
            if (cg.activationStatus === 'active' || cg.activationStatus === 'suspended') {
                if (cg.activationStatus === target || (cg.activationStatus === 'active' && target === 'pending')) {
                    alreadyOk++;
                } else {
                    console.warn(
                        `[DIVERGENCE] caregiver=${cg.id} userId=${cg.userId} activationStatus=${cg.activationStatus} verificationStatus=${cg.verificationStatus}`,
                    );
                    skipped++;
                }
                continue;
            }

            // activationStatus is `pending` (default) — backfill from legacy.
            if (target === 'pending' && cg.activationStatus === 'pending') {
                alreadyOk++;
                continue;
            }

            toUpdate++;
            console.log(
                `  caregiver=${cg.id} userId=${cg.userId} ${cg.verificationStatus} → activationStatus=${target}`,
            );

            if (WRITE) {
                await prisma.caregiver.update({
                    where: { id: cg.id },
                    data: { activationStatus: target },
                });
            }
        }

        console.log('\nSummary:');
        console.log(`  already consistent : ${alreadyOk}`);
        console.log(`  would update       : ${toUpdate}`);
        console.log(`  divergences logged : ${skipped}`);
        console.log(`  mode               : ${WRITE ? 'WRITE (applied)' : 'DRY-RUN (no writes)'}`);
        if (!WRITE && toUpdate > 0) {
            console.log('\nRe-run with --write to apply the changes.');
        }
    } finally {
        await prisma.$disconnect();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
