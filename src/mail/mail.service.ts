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
      port: 587,
      secure: false, // use STARTTLS
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

  async sendServiceNearbyEmail(
    email: string, name: string,
    details: { serviceType: string; patientName: string; distance: number; scheduledDate: Date | null; serviceId: string },
  ) {
    try {
      const dateStr = details.scheduledDate
        ? new Date(details.scheduledDate).toLocaleDateString('es-AR', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })
        : 'A coordinar';

      await this.transporter.sendMail({
        from: `"${this.fromName}" <${this.fromEmail}>`,
        to: email,
        subject: `🔔 Nuevo servicio cerca tuyo - ${details.serviceType}`,
        html: this.baseLayout(`
          <h2 style="margin:0 0 16px;color:#111827;font-size:22px;">¡Hola ${name}!</h2>
          <p style="margin:0 0 16px;color:#4b5563;font-size:15px;line-height:1.6;">
            Hay un nuevo servicio de <strong>${details.serviceType}</strong> que necesita un cuidador cerca de tu ubicación.
          </p>
          <div style="background:#f3f4f6;border-radius:12px;padding:20px;margin:0 0 24px;">
            <p style="margin:0 0 8px;color:#374151;font-size:14px;"><strong>📋 Servicio:</strong> ${details.serviceType}</p>
            <p style="margin:0 0 8px;color:#374151;font-size:14px;"><strong>👤 Paciente:</strong> ${details.patientName}</p>
            <p style="margin:0 0 8px;color:#374151;font-size:14px;"><strong>📍 Distancia:</strong> ${details.distance} km de tu ubicación</p>
            <p style="margin:0;color:#374151;font-size:14px;"><strong>📅 Fecha:</strong> ${dateStr}</p>
          </div>
          <div style="text-align:center;margin:0 0 24px;">
            <a href="${this.configService.get('FRONTEND_URL', 'http://localhost:3000')}/caregiver/dashboard" style="display:inline-block;background:#6366f1;color:#fff;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:600;font-size:15px;">
              Ver Servicio
            </a>
          </div>
          <p style="margin:0;color:#9ca3af;font-size:13px;text-align:center;">
            Si no te interesa, puedes ignorar este email.
          </p>`),
      });
      this.logger.log(`Service nearby email sent to ${email}`);
    } catch (error) {
      this.logger.error(`Failed to send service nearby email to ${email}`, error);
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

  async sendChatNotificationEmail(
    email: string,
    recipientName: string,
    senderName: string,
    messageContent: string,
    serviceId: string,
  ): Promise<void> {
    try {
      await this.transporter.sendMail({
        from: `"${this.fromName}" <${this.fromEmail}>`,
        to: email,
        subject: `💬 Nuevo mensaje de ${senderName} - CHO`,
        html: this.baseLayout(`
          <p style="margin:0 0 16px;color:#4b5563;font-size:15px;line-height:1.6;">
            Hola <strong>${recipientName}</strong>, tenés un nuevo mensaje de <strong>${senderName}</strong>:
          </p>
          <div style="margin:16px 0;padding:16px;background:#f3f4f6;border-radius:8px;border-left:4px solid #0070f3;">
            <p style="margin:0;color:#1f2937;font-size:15px;line-height:1.6;font-style:italic;">
              "${messageContent}"
            </p>
          </div>
          <div style="margin:24px 0;text-align:center;">
            <a href="${this.getFrontendUrl()}/family/chat/${serviceId}"
               style="display:inline-block;background:#0070f3;color:white;text-decoration:none;padding:12px 32px;border-radius:8px;font-weight:600;font-size:15px;">
              Responder
            </a>
          </div>`),
      });
      this.logger.log(`Chat notification email sent to ${email}`);
    } catch (error) {
      this.logger.error(`Failed to send chat notification to ${email}`, error);
    }
  }

  async sendPaymentReleasedEmail(
    email: string,
    name: string,
    amount: number,
    serviceId: string,
  ): Promise<void> {
    try {
      await this.transporter.sendMail({
        from: `"${this.fromName}" <${this.fromEmail}>`,
        to: email,
        subject: `💸 Pago liberado - $${amount.toLocaleString('es-AR')} - CHO`,
        html: this.baseLayout(`
          <p style="margin:0 0 16px;color:#4b5563;font-size:15px;line-height:1.6;">
            Hola <strong>${name}</strong>, tu pago ha sido liberado:
          </p>
          <div style="margin:16px 0;padding:16px;background:#ecfdf5;border-radius:8px;text-align:center;">
            <p style="margin:0;color:#065f46;font-size:28px;font-weight:bold;">
              $${amount.toLocaleString('es-AR')}
            </p>
            <p style="margin:4px 0 0;color:#059669;font-size:14px;">Monto neto depositado</p>
          </div>
          <div style="margin:24px 0;text-align:center;">
            <a href="${this.getFrontendUrl()}/caregiver/dashboard"
               style="display:inline-block;background:#0070f3;color:white;text-decoration:none;padding:12px 32px;border-radius:8px;font-weight:600;font-size:15px;">
              Ver Mis Trabajos
            </a>
          </div>`),
      });
      this.logger.log(`Payment released email sent to ${email}`);
    } catch (error) {
      this.logger.error(`Failed to send payment released email to ${email}`, error);
    }
  }

  // Email: Confirm service was created → to family
  async sendServiceCreatedEmail(
    email: string, name: string,
    details: { serviceType: string; patientName: string; scheduledDate: Date | null; serviceId: string },
  ): Promise<void> {
    try {
      const dateStr = details.scheduledDate
        ? new Date(details.scheduledDate).toLocaleDateString('es-AR', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })
        : 'A coordinar';
      await this.transporter.sendMail({
        from: `"${this.fromName}" <${this.fromEmail}>`,
        to: email,
        subject: `✅ Tu solicitud de servicio fue creada - CHO`,
        html: this.baseLayout(`
          <h2 style="margin:0 0 16px;color:#111827;font-size:22px;">¡Hola ${name}!</h2>
          <p style="margin:0 0 16px;color:#4b5563;font-size:15px;line-height:1.6;">
            Tu solicitud de <strong>${details.serviceType}</strong> para <strong>${details.patientName}</strong> fue creada correctamente.
            Estamos buscando cuidadores cercanos para atenderte.
          </p>
          <div style="background:#f3f4f6;border-radius:12px;padding:20px;margin:0 0 24px;">
            <p style="margin:0 0 8px;font-size:14px;color:#6b7280;">📅 Fecha: <strong>${dateStr}</strong></p>
          </div>
          <p style="margin:0 0 16px;color:#4b5563;font-size:15px;">Te notificaremos cuando un cuidador muestre interés.</p>
          <a href="${this.getFrontendUrl()}/family/services/${details.serviceId}" style="display:inline-block;background:#6366f1;color:#fff;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:600;">Ver mi servicio</a>
        `),
      });
      this.logger.log(`Service created email sent to ${email}`);
    } catch (error) {
      this.logger.error(`Failed to send service created email to ${email}`, error);
    }
  }

  // Email: A caregiver is interested → to family
  async sendCaregiverInterestedEmail(
    email: string, familyName: string,
    details: { caregiverName: string; serviceType: string; serviceId: string },
  ): Promise<void> {
    try {
      await this.transporter.sendMail({
        from: `"${this.fromName}" <${this.fromEmail}>`,
        to: email,
        subject: `👋 ${details.caregiverName} quiere cuidar a tu familiar - CHO`,
        html: this.baseLayout(`
          <h2 style="margin:0 0 16px;color:#111827;font-size:22px;">¡Hola ${familyName}!</h2>
          <p style="margin:0 0 16px;color:#4b5563;font-size:15px;line-height:1.6;">
            <strong>${details.caregiverName}</strong> ha mostrado interés en tu servicio de <strong>${details.serviceType}</strong>.
          </p>
          <p style="margin:0 0 16px;color:#4b5563;font-size:15px;">Podés chatear y ver su perfil para decidir si es la persona indicada.</p>
          <a href="${this.getFrontendUrl()}/family/services/${details.serviceId}" style="display:inline-block;background:#6366f1;color:#fff;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:600;">Ver candidatos</a>
        `),
      });
      this.logger.log(`Caregiver interested email sent to ${email}`);
    } catch (error) {
      this.logger.error(`Failed to send caregiver interested email to ${email}`, error);
    }
  }

  // Email: Family selected this caregiver → to caregiver
  async sendCaregiverSelectedEmail(
    email: string, caregiverName: string,
    details: { familyName: string; serviceType: string; patientName: string; serviceId: string },
  ): Promise<void> {
    try {
      await this.transporter.sendMail({
        from: `"${this.fromName}" <${this.fromEmail}>`,
        to: email,
        subject: `🎉 ¡Te seleccionaron para un servicio! - CHO`,
        html: this.baseLayout(`
          <h2 style="margin:0 0 16px;color:#111827;font-size:22px;">¡Felicidades ${caregiverName}!</h2>
          <p style="margin:0 0 16px;color:#4b5563;font-size:15px;line-height:1.6;">
            La familia <strong>${details.familyName}</strong> te ha seleccionado para cuidar a <strong>${details.patientName}</strong> (${details.serviceType}).
          </p>
          <p style="margin:0 0 16px;color:#4b5563;font-size:15px;">
            El pago se realizará antes del servicio a través de MercadoPago. Una vez confirmado, podrás prestar el servicio.
          </p>
          <a href="${this.getFrontendUrl()}/caregiver/dashboard" style="display:inline-block;background:#6366f1;color:#fff;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:600;">Ir a mi panel</a>
        `),
      });
      this.logger.log(`Caregiver selected email sent to ${email}`);
    } catch (error) {
      this.logger.error(`Failed to send caregiver selected email to ${email}`, error);
    }
  }

  // Email: Payment received for this service → to caregiver
  async sendPaymentReceivedEmail(
    email: string, caregiverName: string,
    details: { familyName: string; serviceType: string; amount: number; serviceId: string },
  ): Promise<void> {
    try {
      await this.transporter.sendMail({
        from: `"${this.fromName}" <${this.fromEmail}>`,
        to: email,
        subject: `💰 Pago recibido - ¡Prestá el servicio! - CHO`,
        html: this.baseLayout(`
          <h2 style="margin:0 0 16px;color:#111827;font-size:22px;">¡Hola ${caregiverName}!</h2>
          <p style="margin:0 0 16px;color:#4b5563;font-size:15px;line-height:1.6;">
            La familia <strong>${details.familyName}</strong> ha realizado el pago de <strong>$${details.amount.toLocaleString('es-AR')}</strong> por el servicio de <strong>${details.serviceType}</strong>.
          </p>
          <div style="background:#dcfce7;border-radius:12px;padding:20px;margin:0 0 24px;">
            <p style="margin:0;font-size:15px;color:#166534;font-weight:600;">
              ✅ El pago está confirmado. Ya podés coordinar y prestar el servicio.
            </p>
          </div>
          <p style="margin:0 0 16px;color:#4b5563;font-size:15px;">
            Una vez completado el servicio, el administrador liberará tu pago.
          </p>
          <a href="${this.getFrontendUrl()}/caregiver/dashboard" style="display:inline-block;background:#6366f1;color:#fff;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:600;">Ir a mi panel</a>
        `),
      });
      this.logger.log(`Payment received email sent to ${email}`);
    } catch (error) {
      this.logger.error(`Failed to send payment received email to ${email}`, error);
    }
  }

  // Email: Notify admin about new user registration
  async sendNewUserNotificationToAdmin(
    userName: string, userEmail: string, role: string,
  ): Promise<void> {
    const adminEmail = this.fromEmail; // Send to the app's admin email
    try {
      const roleLabel = role === 'caregiver' ? 'Cuidador' : 'Familia';
      await this.transporter.sendMail({
        from: `"${this.fromName}" <${this.fromEmail}>`,
        to: adminEmail,
        subject: `🆕 Nuevo registro: ${userName} (${roleLabel})`,
        html: this.baseLayout(`
          <h2 style="color:#333;margin-bottom:16px;">Nuevo usuario registrado</h2>
          <div style="background:#f8f9fa;border-radius:8px;padding:20px;margin-bottom:20px;">
            <p style="margin:4px 0;"><strong>Nombre:</strong> ${userName}</p>
            <p style="margin:4px 0;"><strong>Email:</strong> ${userEmail}</p>
            <p style="margin:4px 0;"><strong>Rol:</strong> ${roleLabel}</p>
            <p style="margin:4px 0;"><strong>Fecha:</strong> ${new Date().toLocaleString('es-AR')}</p>
          </div>
          ${role === 'caregiver' ? `<a href="${this.getFrontendUrl()}/admin/dashboard" style="display:inline-block;background:#0070f3;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">Ver en Panel Admin</a>` : ''}
        `),
      });
      this.logger.log(`Admin notification sent for new user: ${userEmail}`);
    } catch (error) {
      this.logger.error(`Failed to send admin notification for ${userEmail}`, error);
    }
  }

  // Email: Notify caregiver their account was verified/rejected
  async sendAccountVerifiedEmail(
    email: string, name: string, approved: boolean,
  ): Promise<void> {
    try {
      const subject = approved
        ? `✅ ¡Tu cuenta fue verificada, ${name}!`
        : `❌ Actualización de tu cuenta, ${name}`;
      const body = approved
        ? `
          <h2 style="color:#16a34a;margin-bottom:16px;">¡Felicitaciones, ${name}! 🎉</h2>
          <p>Tu cuenta de cuidador fue <strong>verificada exitosamente</strong>.</p>
          <p>Ya podés empezar a recibir solicitudes de trabajo de familias cerca tuyo.</p>
          <div style="text-align:center;margin:24px 0;">
            <a href="${this.getFrontendUrl()}/caregiver/dashboard" style="display:inline-block;background:#16a34a;color:white;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:16px;">Ir al Dashboard</a>
          </div>
        `
        : `
          <h2 style="color:#dc2626;margin-bottom:16px;">Actualización de tu cuenta</h2>
          <p>Hola ${name}, lamentablemente tu cuenta no pudo ser verificada en este momento.</p>
          <p>Si creés que es un error, contactanos respondiendo a este email.</p>
        `;

      await this.transporter.sendMail({
        from: `"${this.fromName}" <${this.fromEmail}>`,
        to: email,
        subject,
        html: this.baseLayout(body),
      });
      this.logger.log(`Account ${approved ? 'verified' : 'rejected'} email sent to ${email}`);
    } catch (error) {
      this.logger.error(`Failed to send verification email to ${email}`, error);
    }
  }

  private getFrontendUrl(): string {
    return this.configService.get<string>('FRONTEND_URL') || 'https://cho.bladelink.company';
  }
}
