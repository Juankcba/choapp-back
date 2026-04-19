import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

// Formato guardado en DB: `enc:v1:<base64(iv(12) || authTag(16) || ciphertext)>`.
// El prefijo `enc:v1:` permite: (a) detectar datos viejos sin cifrar durante
// la ventana de migración, (b) rotar a `v2` en el futuro sin romper lo viejo.
const PREFIX = 'enc:v1:';
const IV_BYTES = 12; // GCM recommended
const TAG_BYTES = 16;

@Injectable()
export class FieldEncryptionService implements OnModuleInit {
    private readonly logger = new Logger(FieldEncryptionService.name);
    private key!: Buffer;

    onModuleInit() {
        const raw = process.env.FIELD_ENCRYPTION_KEY;
        if (!raw) {
            // Fail fast: sin key no podemos leer ni escribir campos sensibles
            // correctamente. Mejor crash en boot que corrupción silenciosa.
            throw new Error(
                'FIELD_ENCRYPTION_KEY env var is required (32 bytes base64). ' +
                'Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
            );
        }
        const key = Buffer.from(raw, 'base64');
        if (key.length !== 32) {
            throw new Error(
                `FIELD_ENCRYPTION_KEY must decode to 32 bytes, got ${key.length}`,
            );
        }
        this.key = key;
    }

    isEncrypted(value: unknown): value is string {
        return typeof value === 'string' && value.startsWith(PREFIX);
    }

    encrypt(plaintext: string | null | undefined): string | null | undefined {
        if (plaintext == null || plaintext === '') return plaintext;
        if (this.isEncrypted(plaintext)) return plaintext; // idempotente
        const iv = randomBytes(IV_BYTES);
        const cipher = createCipheriv('aes-256-gcm', this.key, iv);
        const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
        const tag = cipher.getAuthTag();
        return PREFIX + Buffer.concat([iv, tag, ct]).toString('base64');
    }

    decrypt(value: string | null | undefined): string | null | undefined {
        if (value == null) return value;
        if (!this.isEncrypted(value)) return value; // legacy sin cifrar
        try {
            const raw = Buffer.from(value.slice(PREFIX.length), 'base64');
            const iv = raw.subarray(0, IV_BYTES);
            const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
            const ct = raw.subarray(IV_BYTES + TAG_BYTES);
            const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
            decipher.setAuthTag(tag);
            return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
        } catch (err) {
            // No tirar error — loggear y devolver el ciphertext. Si la key rotó
            // mal o un registro está corrupto, no queremos que el endpoint 500.
            this.logger.error(`Decrypt failed: ${(err as Error).message}`);
            return '[cifrado ilegible]';
        }
    }

    // Campos de Service que contienen datos de salud / PII del paciente.
    // Centralizado acá para evitar que se "olvide" uno en un call site.
    private static readonly SERVICE_SENSITIVE_FIELDS = [
        'patientName',
        'patientCondition',
        'specialNeeds',
    ] as const;

    encryptServiceFields<T extends Record<string, unknown>>(data: T): T {
        if (!data) return data;
        const out: Record<string, unknown> = { ...data };
        for (const f of FieldEncryptionService.SERVICE_SENSITIVE_FIELDS) {
            if (f in out) out[f] = this.encrypt(out[f] as string | null);
        }
        return out as T;
    }

    decryptServiceFields<T extends Record<string, unknown> | null | undefined>(service: T): T {
        if (!service) return service;
        const out: Record<string, unknown> = { ...service };
        for (const f of FieldEncryptionService.SERVICE_SENSITIVE_FIELDS) {
            if (f in out) out[f] = this.decrypt(out[f] as string | null);
        }
        return out as T;
    }

    decryptServiceList<T extends Record<string, unknown>>(list: T[]): T[] {
        return list.map((s) => this.decryptServiceFields(s));
    }
}
