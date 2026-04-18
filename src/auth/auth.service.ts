import {
    Injectable,
    ConflictException,
    UnauthorizedException,
    InternalServerErrorException,
    BadRequestException,
    NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { MatchingGateway } from '../matching/matching.gateway';
import { TelegramService } from '../telegram/telegram.service';
import { RegisterDto, LoginDto } from './dto/auth.dto';
import { TERMS_VERSION } from '../common/legal';

@Injectable()
export class AuthService {
    constructor(
        private prisma: PrismaService,
        private jwtService: JwtService,
        private configService: ConfigService,
        private mailService: MailService,
        private matchingGateway: MatchingGateway,
        private telegramService: TelegramService,
    ) { }

    async getProfile(userId: string) {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            include: {
                caregiver: { select: { id: true } },
                family: { select: { id: true } },
            },
        });
        if (!user) throw new NotFoundException('User not found');
        return {
            id: user.id,
            email: user.email,
            name: user.name,
            firstName: user.firstName,
            lastName: user.lastName,
            role: user.role,
            identityStatus: user.identityStatus,
            caregiverId: user.caregiver?.id || null,
            familyId: user.family?.id || null,
            caregiver: user.caregiver,
            family: user.family,
            needsTermsAcceptance: user.termsAcceptedVersion !== TERMS_VERSION,
            termsVersion: TERMS_VERSION,
        };
    }

    async register(dto: RegisterDto) {
        try {
            const existing = await this.prisma.user.findUnique({
                where: { email: dto.email },
            });
            if (existing) {
                throw new ConflictException('Email already exists');
            }

            // Anchor the consent to the version currently published. The
            // client reports which version it showed to the user; if it's
            // stale (client is on an old build), we reject and force them
            // to refresh.
            if (dto.termsAcceptedVersion !== TERMS_VERSION) {
                throw new BadRequestException(
                    `Terms version mismatch (expected ${TERMS_VERSION}, got ${dto.termsAcceptedVersion}). Please refresh the app and accept the latest terms.`,
                );
            }

            const hashedPassword = await bcrypt.hash(dto.password, 10);

            const user = await this.prisma.user.create({
                data: {
                    email: dto.email,
                    password: hashedPassword,
                    phone: dto.phone,
                    firstName: dto.firstName,
                    lastName: dto.lastName,
                    name: `${dto.firstName} ${dto.lastName}`,
                    role: dto.role,
                    termsAcceptedAt: new Date(),
                    termsAcceptedVersion: TERMS_VERSION,
                },
            });

            if (dto.role === 'caregiver') {
                await this.prisma.caregiver.create({ data: { userId: user.id } });
            } else if (dto.role === 'family') {
                await this.prisma.family.create({ data: { userId: user.id } });
            }

            // Send welcome email (non-blocking)
            this.mailService.sendWelcomeEmail(user.email, user.name || user.firstName || 'Usuario');

            // Notify admins in real-time
            this.matchingGateway.emitToAdmins('new-user', {
                id: user.id,
                name: user.name || `${dto.firstName} ${dto.lastName}`,
                email: user.email,
                role: user.role,
                createdAt: new Date().toISOString(),
            });

            // Email admin about new sign-up
            this.mailService.sendNewUserNotificationToAdmin(
                user.name || `${dto.firstName} ${dto.lastName}`,
                user.email,
                user.role,
            ).catch(() => { /* non-blocking */ });

            // Log to Telegram
            this.telegramService.sendLog('user.registered', {
                name: user.name || `${dto.firstName} ${dto.lastName}`,
                email: user.email,
                phone: dto.phone,
                role: user.role,
            }).catch(() => { /* non-blocking */ });

            const payload = { email: user.email, sub: user.id, role: user.role };
            return {
                access_token: this.jwtService.sign(payload),
                user: { id: user.id, email: user.email, role: user.role, name: user.name, identityStatus: user.identityStatus },
            };
        } catch (error) {
            if (error instanceof ConflictException) throw error;
            console.error('Register error:', error);
            throw new InternalServerErrorException(
                `Registration failed: ${error.message}`,
            );
        }
    }

    async login(dto: LoginDto) {
        const user = await this.prisma.user.findUnique({
            where: { email: dto.email },
        });
        if (!user || !user.password) {
            throw new UnauthorizedException('Invalid credentials');
        }

        const isPasswordValid = await bcrypt.compare(dto.password, user.password);
        if (!isPasswordValid) {
            throw new UnauthorizedException('Invalid credentials');
        }

        if (user.deletedAt) {
            throw new UnauthorizedException('Esta cuenta fue eliminada y ya no puede acceder.');
        }

        await this.prisma.user.update({
            where: { id: user.id },
            data: { lastLogin: new Date() },
        });

        const payload = { email: user.email, sub: user.id, role: user.role };
        return {
            access_token: this.jwtService.sign(payload),
            user: { id: user.id, email: user.email, role: user.role, name: user.name, identityStatus: user.identityStatus },
            needsTermsAcceptance: user.termsAcceptedVersion !== TERMS_VERSION,
            termsVersion: TERMS_VERSION,
        };
    }

    async socialLogin(data: { email: string; name?: string; image?: string; termsAcceptedVersion?: string }) {
        // Parse firstName / lastName from Google display name
        const nameParts = (data.name || '').trim().split(/\s+/);
        const firstName = nameParts[0] || '';
        const lastName = nameParts.slice(1).join(' ') || '';

        let user = await this.prisma.user.findUnique({
            where: { email: data.email },
            include: { family: true, caregiver: true },
        });

        if (user?.deletedAt) {
            throw new UnauthorizedException('Esta cuenta fue eliminada y ya no puede acceder.');
        }

        if (!user) {
            // Social sign-up may not carry a consent version (the Google /
            // Apple flow doesn't let us gate it). If absent, the user is
            // prompted to accept the terms the first time they hit a
            // protected surface — see `needsTermsAcceptance` in the login
            // response.
            const acceptedVersion = data.termsAcceptedVersion === TERMS_VERSION
                ? TERMS_VERSION
                : null;

            user = await this.prisma.user.create({
                data: {
                    email: data.email,
                    name: data.name,
                    firstName,
                    lastName,
                    image: data.image,
                    role: 'pending',
                    termsAcceptedAt: acceptedVersion ? new Date() : null,
                    termsAcceptedVersion: acceptedVersion,
                },
                include: { family: true, caregiver: true },
            });

            // Send welcome email for new social login users
            this.mailService.sendWelcomeEmail(data.email, data.name || 'Usuario');

            // Log to Telegram
            this.telegramService.sendLog('user.social_login_new', {
                name: data.name || 'Sin nombre',
                email: data.email,
                role: 'pending',
            }).catch(() => { /* non-blocking */ });
        } else {
            // Update existing user: fill missing fields + update lastLogin
            const updateData: any = { lastLogin: new Date() };
            if (!user.firstName && firstName) updateData.firstName = firstName;
            if (!user.lastName && lastName) updateData.lastName = lastName;
            if (!user.name && data.name) updateData.name = data.name;
            if (!user.image && data.image) updateData.image = data.image;

            await this.prisma.user.update({
                where: { id: user.id },
                data: updateData,
            });
        }

        const hasProfile = user.family || user.caregiver;
        const role = user.role === 'admin' ? 'admin' : (hasProfile ? user.role : 'pending');

        const payload = { email: user.email, sub: user.id, role };
        return {
            access_token: this.jwtService.sign(payload),
            user: { id: user.id, email: user.email, role, name: user.name || data.name, identityStatus: user.identityStatus },
            needsTermsAcceptance: user.termsAcceptedVersion !== TERMS_VERSION,
            termsVersion: TERMS_VERSION,
        };
    }

    /**
     * Record the user's acceptance of the current TERMS_VERSION. Called from
     * the mobile / web client once the user ticks the acceptance box on the
     * gate shown when `needsTermsAcceptance` is true.
     */
    async acceptTerms(userId: string, version: string) {
        if (version !== TERMS_VERSION) {
            throw new BadRequestException(
                `Terms version mismatch (expected ${TERMS_VERSION}, got ${version}). Please refresh the app.`,
            );
        }
        await this.prisma.user.update({
            where: { id: userId },
            data: {
                termsAcceptedAt: new Date(),
                termsAcceptedVersion: TERMS_VERSION,
            },
        });
        return { ok: true, termsVersion: TERMS_VERSION };
    }

    async setRole(userId: string, role: 'family' | 'caregiver') {
        const user = await this.prisma.user.update({
            where: { id: userId },
            data: { role },
        });

        if (role === 'family') {
            const existing = await this.prisma.family.findUnique({ where: { userId } });
            if (!existing) {
                await this.prisma.family.create({ data: { userId } });
            }
        } else if (role === 'caregiver') {
            const existing = await this.prisma.caregiver.findUnique({ where: { userId } });
            if (!existing) {
                await this.prisma.caregiver.create({ data: { userId } });
            }
        }

        // Log to Telegram
        this.telegramService.sendLog('user.role_selected', {
            name: user.name || user.firstName || user.email,
            email: user.email,
            role,
        }).catch(() => { /* non-blocking */ });

        const payload = { email: user.email, sub: user.id, role: user.role };
        return {
            access_token: this.jwtService.sign(payload),
            user: { id: user.id, email: user.email, role: user.role, name: user.name },
        };
    }

    async validateUser(email: string, password: string) {
        const user = await this.prisma.user.findUnique({ where: { email } });
        if (!user || !user.password) return null;

        const isPasswordValid = await bcrypt.compare(password, user.password);
        if (!isPasswordValid) return null;

        return {
            id: user.id,
            email: user.email,
            role: user.role,
            firstName: user.firstName,
            lastName: user.lastName,
        };
    }

    // ─── Forgot / Reset Password ─────────────────────────

    async forgotPassword(email: string) {
        const user = await this.prisma.user.findUnique({ where: { email } });

        // Always return success to prevent email enumeration
        if (!user) {
            return { message: 'Si el email existe, recibirás un enlace para restablecer tu contraseña.' };
        }

        // Invalidate any existing tokens for this user
        await this.prisma.passwordReset.updateMany({
            where: { userId: user.id, used: false },
            data: { used: true },
        });

        // Generate secure token
        const token = crypto.randomBytes(32).toString('hex');
        const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

        await this.prisma.passwordReset.create({
            data: {
                userId: user.id,
                token,
                expires,
            },
        });

        const frontendUrl = this.configService.get<string>('FRONTEND_URL') || 'https://cho.bladelink.company';
        const resetUrl = `${frontendUrl}/reset-password?token=${token}`;

        await this.mailService.sendPasswordResetEmail(
            user.email,
            user.name || user.firstName || 'Usuario',
            resetUrl,
        );

        return { message: 'Si el email existe, recibirás un enlace para restablecer tu contraseña.' };
    }

    async resetPassword(token: string, newPassword: string) {
        if (!token || !newPassword) {
            throw new BadRequestException('Token y nueva contraseña son requeridos');
        }

        if (newPassword.length < 6) {
            throw new BadRequestException('La contraseña debe tener al menos 6 caracteres');
        }

        const passwordReset = await this.prisma.passwordReset.findUnique({
            where: { token },
            include: { user: true },
        });

        if (!passwordReset) {
            throw new NotFoundException('Token inválido o expirado');
        }

        if (passwordReset.used) {
            throw new BadRequestException('Este enlace ya fue utilizado');
        }

        if (passwordReset.expires < new Date()) {
            throw new BadRequestException('Este enlace ha expirado. Solicita uno nuevo.');
        }

        // Hash and update password
        const hashedPassword = await bcrypt.hash(newPassword, 10);

        await this.prisma.user.update({
            where: { id: passwordReset.userId },
            data: { password: hashedPassword },
        });

        // Mark token as used
        await this.prisma.passwordReset.update({
            where: { id: passwordReset.id },
            data: { used: true },
        });

        // Send confirmation email
        await this.mailService.sendPasswordChangedEmail(
            passwordReset.user.email,
            passwordReset.user.name || passwordReset.user.firstName || 'Usuario',
        );

        return { message: 'Tu contraseña ha sido actualizada exitosamente.' };
    }
}
