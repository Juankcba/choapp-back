import {
    Injectable,
    ConflictException,
    UnauthorizedException,
    InternalServerErrorException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { RegisterDto, LoginDto } from './dto/auth.dto';

@Injectable()
export class AuthService {
    constructor(
        private prisma: PrismaService,
        private jwtService: JwtService,
    ) { }

    async register(dto: RegisterDto) {
        try {
            const existing = await this.prisma.user.findUnique({
                where: { email: dto.email },
            });
            if (existing) {
                throw new ConflictException('Email already exists');
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
                },
            });

            if (dto.role === 'caregiver') {
                await this.prisma.caregiver.create({ data: { userId: user.id } });
            } else if (dto.role === 'family') {
                await this.prisma.family.create({ data: { userId: user.id } });
            }

            const payload = { email: user.email, sub: user.id, role: user.role };
            return {
                access_token: this.jwtService.sign(payload),
                user: { id: user.id, email: user.email, role: user.role, name: user.name },
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

        await this.prisma.user.update({
            where: { id: user.id },
            data: { lastLogin: new Date() },
        });

        const payload = { email: user.email, sub: user.id, role: user.role };
        return {
            access_token: this.jwtService.sign(payload),
            user: { id: user.id, email: user.email, role: user.role, name: user.name },
        };
    }

    async socialLogin(data: { email: string; name?: string; image?: string }) {
        let user = await this.prisma.user.findUnique({
            where: { email: data.email },
            include: { family: true, caregiver: true },
        });

        if (!user) {
            user = await this.prisma.user.create({
                data: {
                    email: data.email,
                    name: data.name,
                    image: data.image,
                    role: 'pending',
                },
                include: { family: true, caregiver: true },
            });
        } else {
            await this.prisma.user.update({
                where: { id: user.id },
                data: { lastLogin: new Date() },
            });
        }

        const hasProfile = user.family || user.caregiver;
        const role = hasProfile ? user.role : 'pending';

        const payload = { email: user.email, sub: user.id, role };
        return {
            access_token: this.jwtService.sign(payload),
            user: { id: user.id, email: user.email, role, name: user.name },
        };
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
}
