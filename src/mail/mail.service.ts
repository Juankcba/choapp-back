import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

@Injectable()
export class MailService {
  private transporter: nodemailer.Transporter;
  private readonly logger = new Logger(MailService.name);
  private readonly fromEmail: string;
  private readonly fromName = 'CHO - Cuidadores';

  constructor(private configService: ConfigService) {
    const user = this.configService.get<string>('MAIL_USER');
    const pass = this.configService.get<string>('MAIL_APP_PASSWORD');
    this.fromEmail = user || 'cho.live.app@gmail.com';

    this.logger.log(`Configuring mail with user: ${user ? user : '(not set)'}`);

    this.transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user, pass },
      connectionTimeout: 30000,
      greetingTimeout: 30000,
      socketTimeout: 30000,
    });

    // Verify connection on startup
    this.transporter.verify().then(() => {
      this.logger.log('✅ Mail transport ready');
    }).catch((err) => {
      this.logger.warn(`❌ Mail transport not ready: ${err.message}`);
    });
  }

  async sendWelcomeEmail(email: string, name: string): Promise<void> {
    try {
      await this.transporter.sendMail({
        from: `"${this.fromName}" <${this.fromEmail}>`,
        to: email,
        subject: '¡Bienvenido a CHO! 🎉',
        html: this.welcomeTemplate(name),
      });
      this.logger.log(`Welcome email sent to ${email}`);
    } catch (error) {
      this.logger.error(`Failed to send welcome email to ${email}`, error);
    }
  }

  async sendPasswordResetEmail(email: string, name: string, resetUrl: string): Promise<void> {
    try {
      await this.transporter.sendMail({
        from: `"${this.fromName}" <${this.fromEmail}>`,
        to: email,
        subject: 'Restablecer tu contraseña - CHO',
        html: this.passwordResetTemplate(name, resetUrl),
      });
      this.logger.log(`Password reset email sent to ${email}`);
    } catch (error) {
      this.logger.error(`Failed to send password reset email to ${email}`, error);
    }
  }

  async sendPasswordChangedEmail(email: string, name: string): Promise<void> {
    try {
      await this.transporter.sendMail({
        from: `"${this.fromName}" <${this.fromEmail}>`,
        to: email,
        subject: 'Tu contraseña ha sido cambiada - CHO',
        html: this.passwordChangedTemplate(name),
      });
      this.logger.log(`Password changed email sent to ${email}`);
    } catch (error) {
      this.logger.error(`Failed to send password changed email to ${email}`, error);
    }
  }

  async sendTestEmail(toEmail: string): Promise<{ success: boolean; message: string }> {
    try {
      const info = await this.transporter.sendMail({
        from: `"${this.fromName}" <${this.fromEmail}>`,
        to: toEmail,
        subject: '🧪 Test - CHO Mail Service',
        html: this.baseLayout(`
          <h2 style="margin:0 0 16px;color:#111827;font-size:22px;">Test Email ✅</h2>
          <p style="margin:0 0 16px;color:#4b5563;font-size:15px;line-height:1.6;">
            Si estás leyendo esto, el servicio de email de <strong>CHO</strong> funciona correctamente.
          </p>
          <p style="margin:0;color:#9ca3af;font-size:13px;">
            Enviado: ${new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}
          </p>`),
      });
      this.logger.log(`Test email sent to ${toEmail} - messageId: ${info.messageId}`);
      return { success: true, message: `Email sent to ${toEmail}` };
    } catch (error) {
      this.logger.error(`Failed to send test email to ${toEmail}`, error);
      return { success: false, message: error.message };
    }
  }

  // ─── HTML Templates ──────────────────────────────────

  private baseLayout(content: string): string {
    return `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#f4f4f5;font-family:'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:40px 20px;">
    <div style="background:white;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
      <!-- Header -->
      <div style="background:linear-gradient(135deg,#0070f3,#00a6ff);padding:32px;text-align:center;">
        <h1 style="margin:0;color:white;font-size:28px;font-weight:bold;">❤️ CHO</h1>
        <p style="margin:8px 0 0;color:rgba(255,255,255,0.9);font-size:14px;">Cuidadores de Hogares y Hospitales</p>
      </div>
      <!-- Content -->
      <div style="padding:32px;">
        ${content}
      </div>
      <!-- Footer -->
      <div style="padding:24px 32px;background:#f9fafb;text-align:center;border-top:1px solid #e5e7eb;">
        <p style="margin:0;color:#9ca3af;font-size:12px;">
          © 2026 CHO - Cuidadores de Hogares y Hospitales<br>
          Este email fue enviado a esta dirección porque tienes una cuenta en CHO.
        </p>
      </div>
    </div>
  </div>
</body>
</html>`;
  }

  private welcomeTemplate(name: string): string {
    return this.baseLayout(`
        <h2 style="margin:0 0 16px;color:#111827;font-size:22px;">¡Hola ${name}! 👋</h2>
        <p style="margin:0 0 16px;color:#4b5563;font-size:15px;line-height:1.6;">
          Bienvenido/a a <strong>CHO</strong>. Estamos encantados de tenerte con nosotros.
        </p>
        <p style="margin:0 0 16px;color:#4b5563;font-size:15px;line-height:1.6;">
          Tu cuenta ha sido creada exitosamente. Ya puedes comenzar a utilizar nuestra plataforma
          para conectar con cuidadores profesionales verificados o para ofrecer tus servicios de cuidado.
        </p>
        <div style="margin:24px 0;text-align:center;">
          <a href="${this.getFrontendUrl()}/login"
             style="display:inline-block;background:#0070f3;color:white;text-decoration:none;padding:12px 32px;border-radius:8px;font-weight:600;font-size:15px;">
            Ir a mi cuenta
          </a>
        </div>
        <p style="margin:0;color:#9ca3af;font-size:13px;">
          Si tienes alguna pregunta, no dudes en contactarnos a través de nuestra plataforma.
        </p>`);
  }

  private passwordResetTemplate(name: string, resetUrl: string): string {
    return this.baseLayout(`
        <h2 style="margin:0 0 16px;color:#111827;font-size:22px;">Restablecer contraseña</h2>
        <p style="margin:0 0 16px;color:#4b5563;font-size:15px;line-height:1.6;">
          Hola <strong>${name}</strong>, recibimos una solicitud para restablecer la contraseña de tu cuenta.
        </p>
        <p style="margin:0 0 16px;color:#4b5563;font-size:15px;line-height:1.6;">
          Haz clic en el siguiente botón para crear una nueva contraseña. Este enlace expirará en <strong>1 hora</strong>.
        </p>
        <div style="margin:24px 0;text-align:center;">
          <a href="${resetUrl}"
             style="display:inline-block;background:#0070f3;color:white;text-decoration:none;padding:12px 32px;border-radius:8px;font-weight:600;font-size:15px;">
            Restablecer contraseña
          </a>
        </div>
        <p style="margin:0 0 8px;color:#9ca3af;font-size:13px;">
          Si no solicitaste este cambio, puedes ignorar este email. Tu contraseña no será modificada.
        </p>
        <p style="margin:0;color:#9ca3af;font-size:12px;word-break:break-all;">
          Si el botón no funciona, copia y pega este enlace: ${resetUrl}
        </p>`);
  }

  private passwordChangedTemplate(name: string): string {
    return this.baseLayout(`
        <h2 style="margin:0 0 16px;color:#111827;font-size:22px;">Contraseña actualizada ✅</h2>
        <p style="margin:0 0 16px;color:#4b5563;font-size:15px;line-height:1.6;">
          Hola <strong>${name}</strong>, tu contraseña ha sido cambiada exitosamente.
        </p>
        <p style="margin:0 0 16px;color:#4b5563;font-size:15px;line-height:1.6;">
          Si no realizaste este cambio, por favor contacta a nuestro equipo de soporte inmediatamente.
        </p>
        <div style="margin:24px 0;text-align:center;">
          <a href="${this.getFrontendUrl()}/login"
             style="display:inline-block;background:#0070f3;color:white;text-decoration:none;padding:12px 32px;border-radius:8px;font-weight:600;font-size:15px;">
            Iniciar Sesión
          </a>
        </div>`);
  }

  private getFrontendUrl(): string {
    return this.configService.get<string>('FRONTEND_URL') || 'https://cho.bladelink.company';
  }
}
