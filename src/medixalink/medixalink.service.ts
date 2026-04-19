import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// Identificador del partner cho frente a medixalink. El auth-service lo
// concatena al `sessionId` para formar el roomName de Jitsi.
export const MEDIXALINK_PARTNER_ID = 'cho';

export interface PartnerSessionUser {
    name: string;
    email?: string;
}

export interface PartnerSessionTokenResult {
    roomName: string;
    videoDomain: string;
    moderatorToken: string;   // para el cuidador
    participantToken: string; // para la familia
    expiresAt: string;
}

/**
 * Cliente HTTP contra medixalink auth-service.
 *
 * Toda la integración con la infraestructura de videollamadas de medixalink
 * vive en este módulo — el resto del backend de cho no conoce URLs ni claves.
 * Así limitamos la superficie de cambio si mañana migramos a otra plataforma
 * de video o medixalink expone más endpoints.
 */
@Injectable()
export class MedixalinkService {
    private readonly logger = new Logger(MedixalinkService.name);

    constructor(private readonly config: ConfigService) { }

    private getAuthUrl(): string {
        const url = this.config.get<string>('MEDIXALINK_AUTH_URL');
        if (!url) {
            throw new InternalServerErrorException(
                'MEDIXALINK_AUTH_URL no configurado',
            );
        }
        return url.replace(/\/$/, '');
    }

    private getInternalApiKey(): string {
        const key = this.config.get<string>('MEDIXALINK_INTERNAL_API_KEY');
        if (!key) {
            throw new InternalServerErrorException(
                'MEDIXALINK_INTERNAL_API_KEY no configurado',
            );
        }
        return key;
    }

    /**
     * Solicita a medixalink los tokens de sala Jitsi para una VideoSession de
     * cho. Devuelve un token moderador (cuidador) y uno regular (familia).
     * Ambos sin recording / livestreaming / transcription — cho no guarda
     * nada del contenido del video.
     */
    async requestSessionTokens(params: {
        sessionId: string;
        startAt: Date;
        durationMin: number;
        caregiver: PartnerSessionUser;
        family: PartnerSessionUser;
    }): Promise<PartnerSessionTokenResult> {
        const url = `${this.getAuthUrl()}/tools/telemedicine/partner-token`;

        const body = {
            partnerId: MEDIXALINK_PARTNER_ID,
            sessionId: params.sessionId,
            startAt: params.startAt.toISOString(),
            durationMin: params.durationMin,
            moderator: params.caregiver,
            participant: params.family,
        };

        let response: Response;
        try {
            response = await fetch(url, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'x-internal-api-key': this.getInternalApiKey(),
                },
                body: JSON.stringify(body),
            });
        } catch (err) {
            this.logger.error('Error de red contra medixalink', err as Error);
            throw new InternalServerErrorException(
                'No se pudo contactar al servicio de video',
            );
        }

        if (!response.ok) {
            const text = await response.text().catch(() => '');
            this.logger.error(
                `Medixalink respondió ${response.status}: ${text.slice(0, 300)}`,
            );
            // Mensajes más específicos para debug más rápido en el frontend.
            if (response.status === 401 || response.status === 403) {
                throw new InternalServerErrorException(
                    `Medixalink rechazó la credencial (${response.status}) — revisar MEDIXALINK_INTERNAL_API_KEY`,
                );
            }
            throw new InternalServerErrorException(
                `Medixalink respondió ${response.status} — ${text.slice(0, 100)}`,
            );
        }

        const data = (await response.json()) as PartnerSessionTokenResult;
        if (!data.moderatorToken || !data.participantToken || !data.roomName) {
            this.logger.error('Respuesta de medixalink sin tokens esperados');
            throw new InternalServerErrorException(
                'Respuesta inválida del servicio de video',
            );
        }
        return data;
    }
}
