/**
 * One-shot: limpia en Atlas todos los campos y colecciones que dejaron de
 * tener uso cuando CHO pasó a ser plataforma de conexión sin intermediar
 * pagos (2026-04-19).
 *
 * Qué hace:
 *  1. Drop de la colección `ServicePayout` (modelo eliminado en schema).
 *  2. `$unset` de los campos obsoletos en Caregiver (bankCbu, bankAlias,
 *     bankName, earningsTotal, earningsPending, earningsAvailable,
 *     paymentSchemes).
 *  3. `$unset` de los campos obsoletos en Service (amount, paymentMethod,
 *     paymentStatus, mpPaymentId, mpPreferenceId, commissionFamily,
 *     commissionCarer, netAmount, releasedAt, agreedHourlyRate,
 *     paymentScheme).
 *  4. `$unset` de los campos obsoletos en VideoSession (paymentStatus,
 *     amount, netAmount, commissionFamily, mpPreferenceId, mpPaymentId,
 *     paymentReleasedAt, paymentReminderAt).
 *
 * Dry-run por defecto (cuenta cuántos documentos se tocarían sin modificar
 * nada). Pasar `--write` para ejecutar.
 *
 *   npx ts-node scripts/wipe_payment_fields.ts          # dry run
 *   npx ts-node scripts/wipe_payment_fields.ts --write  # aplicar
 *
 * Idempotente: volver a correrlo con `--write` no hace daño, los fields
 * ya removidos no aparecen más.
 *
 * Usa mongosh-like ops a través del driver nativo (no Prisma) porque los
 * campos a borrar ya no existen en el schema y Prisma no puede escribirlos.
 */

import { MongoClient } from 'mongodb';

const WRITE = process.argv.includes('--write');

async function main() {
    const uri = process.env.MONGODB_URI || process.env.DATABASE_URL;
    if (!uri) {
        throw new Error('MONGODB_URI (o DATABASE_URL) requerida en env.');
    }

    const client = new MongoClient(uri);
    await client.connect();

    try {
        const dbName = new URL(uri).pathname.slice(1).split('?')[0] || 'cho-app';
        const db = client.db(dbName);
        console.log(`Conectado a DB: ${dbName} (${WRITE ? 'WRITE MODE' : 'DRY-RUN'})\n`);

        // 1. Drop ServicePayout
        const payoutColl = db.collection('ServicePayout');
        const payoutCount = await payoutColl.countDocuments();
        console.log(`ServicePayout: ${payoutCount} documentos`);
        if (WRITE && payoutCount >= 0) {
            await payoutColl.drop().catch(() => undefined);
            console.log('  → colección dropeada');
        }

        // 2. Caregiver
        const caregivers = db.collection('Caregiver');
        const caregiverFilter = {
            $or: [
                { bankCbu: { $exists: true } },
                { bankAlias: { $exists: true } },
                { bankName: { $exists: true } },
                { earningsTotal: { $exists: true } },
                { earningsPending: { $exists: true } },
                { earningsAvailable: { $exists: true } },
                { paymentSchemes: { $exists: true } },
            ],
        };
        const caregiverCount = await caregivers.countDocuments(caregiverFilter);
        console.log(`Caregiver con campos obsoletos: ${caregiverCount}`);
        if (WRITE && caregiverCount > 0) {
            const res = await caregivers.updateMany(caregiverFilter, {
                $unset: {
                    bankCbu: '',
                    bankAlias: '',
                    bankName: '',
                    earningsTotal: '',
                    earningsPending: '',
                    earningsAvailable: '',
                    paymentSchemes: '',
                },
            });
            console.log(`  → ${res.modifiedCount} actualizados`);
        }

        // 3. Service
        const services = db.collection('Service');
        const serviceFilter = {
            $or: [
                { amount: { $exists: true } },
                { paymentMethod: { $exists: true } },
                { paymentStatus: { $exists: true } },
                { mpPaymentId: { $exists: true } },
                { mpPreferenceId: { $exists: true } },
                { commissionFamily: { $exists: true } },
                { commissionCarer: { $exists: true } },
                { netAmount: { $exists: true } },
                { releasedAt: { $exists: true } },
                { agreedHourlyRate: { $exists: true } },
                { paymentScheme: { $exists: true } },
            ],
        };
        const serviceCount = await services.countDocuments(serviceFilter);
        console.log(`Service con campos obsoletos: ${serviceCount}`);
        if (WRITE && serviceCount > 0) {
            const res = await services.updateMany(serviceFilter, {
                $unset: {
                    amount: '',
                    paymentMethod: '',
                    paymentStatus: '',
                    mpPaymentId: '',
                    mpPreferenceId: '',
                    commissionFamily: '',
                    commissionCarer: '',
                    netAmount: '',
                    releasedAt: '',
                    agreedHourlyRate: '',
                    paymentScheme: '',
                },
            });
            console.log(`  → ${res.modifiedCount} actualizados`);
        }

        // 4. VideoSession
        const videoSessions = db.collection('VideoSession');
        const vsFilter = {
            $or: [
                { paymentStatus: { $exists: true } },
                { amount: { $exists: true } },
                { netAmount: { $exists: true } },
                { commissionFamily: { $exists: true } },
                { mpPreferenceId: { $exists: true } },
                { mpPaymentId: { $exists: true } },
                { paymentReleasedAt: { $exists: true } },
                { paymentReminderAt: { $exists: true } },
            ],
        };
        const vsCount = await videoSessions.countDocuments(vsFilter);
        console.log(`VideoSession con campos obsoletos: ${vsCount}`);
        if (WRITE && vsCount > 0) {
            const res = await videoSessions.updateMany(vsFilter, {
                $unset: {
                    paymentStatus: '',
                    amount: '',
                    netAmount: '',
                    commissionFamily: '',
                    mpPreferenceId: '',
                    mpPaymentId: '',
                    paymentReleasedAt: '',
                    paymentReminderAt: '',
                },
            });
            console.log(`  → ${res.modifiedCount} actualizados`);
        }

        console.log(`\n${WRITE ? '✔ Cleanup aplicado.' : 'Dry-run. Re-ejecutar con --write para aplicar.'}`);
    } finally {
        await client.close();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
