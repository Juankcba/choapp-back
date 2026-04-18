/**
 * One-shot backfill: mark every pre-existing user as if they had accepted
 * the current TERMS_VERSION at the moment of this run. Done so the 60 users
 * who created their accounts before the legal framework rollout do NOT hit
 * the re-acceptance gate on their next login.
 *
 * Idempotent: skips users who already have a `termsAcceptedVersion` that
 * matches the current TERMS_VERSION.
 *
 * Dry-run by default; pass `--write` to apply.
 *
 *   npx ts-node scripts/backfill_terms_acceptance.ts          # dry run
 *   npx ts-node scripts/backfill_terms_acceptance.ts --write  # apply
 */

import { PrismaClient } from '@prisma/client';
import { TERMS_VERSION } from '../src/common/legal';

const WRITE = process.argv.includes('--write');

async function main() {
    const prisma = new PrismaClient();
    try {
        const users = await prisma.user.findMany({
            select: {
                id: true,
                email: true,
                termsAcceptedAt: true,
                termsAcceptedVersion: true,
                deletedAt: true,
            },
        });

        let toUpdate = 0;
        let alreadyOk = 0;
        let skippedDeleted = 0;

        const now = new Date();

        console.log(`Scanned ${users.length} users. Target version: ${TERMS_VERSION}\n`);

        for (const u of users) {
            if (u.deletedAt) {
                skippedDeleted++;
                continue;
            }
            if (u.termsAcceptedVersion === TERMS_VERSION && u.termsAcceptedAt) {
                alreadyOk++;
                continue;
            }

            toUpdate++;
            console.log(`  ${u.email || u.id}: ${u.termsAcceptedVersion ?? 'null'} → ${TERMS_VERSION}`);

            if (WRITE) {
                await prisma.user.update({
                    where: { id: u.id },
                    data: {
                        termsAcceptedAt: now,
                        termsAcceptedVersion: TERMS_VERSION,
                    },
                });
            }
        }

        console.log('\nSummary:');
        console.log(`  already consistent : ${alreadyOk}`);
        console.log(`  skipped (deleted)  : ${skippedDeleted}`);
        console.log(`  would update       : ${toUpdate}`);
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
