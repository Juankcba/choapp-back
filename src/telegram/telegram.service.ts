import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class TelegramService {
    private readonly logger = new Logger(TelegramService.name);
    private readonly botToken: string;
    private readonly chatId: string;
    private readonly enabled: boolean;

    constructor(private configService: ConfigService) {
        this.botToken = this.configService.get<string>('TELEGRAM_BOT_TOKEN') || '';
        this.chatId = this.configService.get<string>('TELEGRAM_CHAT_ID') || '';
        this.enabled = !!(this.botToken && this.chatId);

        if (!this.enabled) {
            this.logger.warn('Telegram logger disabled: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set');
        }
    }

    async sendLog(event: string, data: Record<string, any>): Promise<void> {
        if (!this.enabled) return;

        const message = this.formatMessage(event, data);

        try {
            const res = await fetch(
                `https://api.telegram.org/bot${this.botToken}/sendMessage`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: this.chatId,
                        text: message,
                        parse_mode: 'HTML',
                        disable_web_page_preview: true,
                    }),
                },
            );

            if (!res.ok) {
                const err = await res.text();
                this.logger.error(`Telegram API error: ${err}`);
            }
        } catch (error) {
            this.logger.error(`Telegram send failed: ${error.message}`);
        }
    }

    private formatMessage(event: string, data: Record<string, any>): string {
        const eventConfig: Record<string, { emoji: string; title: string }> = {
            'user.registered': { emoji: '🆕', title: 'Nuevo Registro' },
            'user.social_login_new': { emoji: '🔗', title: 'Registro con Google' },
            'user.role_selected': { emoji: '👤', title: 'Rol Seleccionado' },
            'user.onboarding_completed': { emoji: '✅', title: 'Onboarding Completado' },
            'user.identity_verified': { emoji: '🪪', title: 'Identidad Verificada' },
            'user.identity_rejected': { emoji: '❌', title: 'Identidad Rechazada' },
            'user.identity_pending': { emoji: '⏳', title: 'Verificacion Iniciada' },
            'user.activated': { emoji: '🟢', title: 'Usuario Activado' },
            'user.deactivated': { emoji: '🔴', title: 'Usuario Desactivado' },
            'caregiver.verified': { emoji: '✅', title: 'Cuidador Aprobado' },
            'caregiver.rejected': { emoji: '❌', title: 'Cuidador Rechazado' },
        };

        const config = eventConfig[event] || { emoji: '📋', title: event };
        const timestamp = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });

        let msg = `${config.emoji} <b>${config.title}</b>\n`;
        msg += `🕐 ${timestamp}\n`;
        msg += `━━━━━━━━━━━━━━━\n`;

        for (const [key, value] of Object.entries(data)) {
            if (value !== undefined && value !== null && value !== '') {
                const label = this.labelMap[key] || key;
                msg += `${label}: <b>${value}</b>\n`;
            }
        }

        return msg;
    }

    private readonly labelMap: Record<string, string> = {
        name: '👤 Nombre',
        email: '📧 Email',
        phone: '📱 Teléfono',
        role: '🏷 Rol',
        status: '📊 Estado',
        identityStatus: '🪪 Identidad',
        reason: '📝 Razón',
        adminNote: '📝 Nota admin',
    };
}
