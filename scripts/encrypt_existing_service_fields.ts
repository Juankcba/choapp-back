/**
 * One-shot: cifra los campos sensibles de Service (patientName,
 * patientCondition, specialNeeds) que quedaron en texto plano en la base
 * cuando todavía no había cifrado a nivel campo (Ley 25.326 / PDPA).
 *
 * Idempotente — los registros que ya empiezan con `enc:v1:` se saltan.
 * Dry-run por defecto; pasar `--write` para aplicar.
 *
 *   FIELD_ENCRYPTION_KEY=<base64> npx ts-node scripts/encrypt_existing_service_fields.ts          # dry run
 *   FIELD_ENCRYPTION_KEY=<base64> npx ts-node scripts/encrypt_existing_service_fields.ts --write  # apply
 *
 * NO rotamos la key acá. Si en el futuro necesitamos rotar, se escribe un
 * script separado que lee con la vieja y escribe con la nueva (y cambiamos
 * el prefijo a `enc:v2:`).
 */

import { PrismaClient } from '@prisma/client';
import { createCipheriv, randomBytes } from 'crypto';

const PREFIX = 'enc:v1:';
const WRITE = process.argv.includes('--write');

function loadKey(): Buffer {
    const raw = process.env.FIELD_ENCRYPTION_KEY;
    if (!raw) {
        throw new Error(
            'FIELD_ENCRYPTION_KEY env var requerida (32 bytes base64). ' +
            'Generar con: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
        );
    }
    const key = Buffer.from(raw, 'base64');
    if (key.length !== 32) throw new Error(`FIELD_ENCRYPTION_KEY decodificó a ${key.length} bytes (se esperaban 32)`);
    return key;
}

function encrypt(plaintext: string, key: Buffer): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return PREFIX + Buffer.concat([iv, tag, ct]).toString('base64');
}

const FIELDS = ['patientName', 'patientCondition', 'specialNeeds'] as const;

async function main() {
    const key = loadKey();
    const prisma = new PrismaClient();
    try {
        const services = await prisma.service.findMany({
            select: { id: true, patientName: true, patientCondition: true, specialNeeds: true },
        });

        let scanned = 0;
        let alreadyEncrypted = 0;
        let nullFields = 0;
        let wouldEncrypt = 0;
        let updated = 0;

        console.log(`Escaneando ${services.length} services...\n`);

        for (const s of services) {
            scanned++;
            const updates: Record<string, string> = {};
            for (const f of FIELDS) {
                const v = (s as Record<string, unknown>)[f];
                if (v == null || v === '') {
                    nullFields++;
                    continue;
                }
                if (typeof v !== 'string') continue;
                if (v.startsWith(PREFIX)) {
                    alreadyEncrypted++;
                    continue;
                }
                updates[f] = encrypt(v, key);
                wouldEncrypt++;
            }

            if (Object.keys(updates).length === 0) continue;

            console.log(`  ${s.id}: cifrar [${Object.keys(updates).join(', ')}]`);
            if (WRITE) {
                await prisma.service.update({ where: { id: s.id }, data: updates });
                updated++;
            }
        }

        console.log('\nResumen:');
        console.log(`  services escaneados     : ${scanned}`);
        console.log(`  campos null/vacíos      : ${nullFields}`);
        console.log(`  campos ya cifrados      : ${alreadyEncrypted}`);
        console.log(`  campos a cifrar         : ${wouldEncrypt}`);
        console.log(`  modo                    : ${WRITE ? `WRITE (${updated} services actualizados)` : 'DRY-RUN (sin cambios)'}`);
        if (!WRITE && wouldEncrypt > 0) {
            console.log('\nRe-ejecutar con --write para aplicar.');
        }
    } finally {
        await prisma.$disconnect();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
