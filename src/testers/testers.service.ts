import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramService } from '../telegram/telegram.service';
import { MailService } from '../mail/mail.service';

@Injectable()
export class TestersService {
    constructor(
        private prisma: PrismaService,
        private telegramService: TelegramService,
        private mailService: MailService,
    ) { }

    async checkByEmail(email: string) {
        if (!email) return { registered: false };
        const tester = await this.prisma.betaTester.findUnique({ where: { email } });
        return { registered: !!tester };
    }

    async register(data: {
        email: string;
        name: string;
        phone?: string;
        device: string;
        googleEmail?: string;
        source: string;
        userId?: string;
    }) {
        const existing = await this.prisma.betaTester.findUnique({
            where: { email: data.email },
        });
        if (existing) {
            throw new ConflictException('Este email ya está registrado como tester');
        }

        const tester = await this.prisma.betaTester.create({ data });

        // Log to Telegram
        this.telegramService.sendLog('tester.registered', {
            name: data.name,
            email: data.email,
            phone: data.phone || '-',
            device: data.device,
            source: data.source,
            googleEmail: data.googleEmail || '-',
        } as any).catch(() => { /* non-blocking */ });

        return tester;
    }

    async getAll(filters?: { status?: string; device?: string; search?: string }) {
        const where: any = {};
        if (filters?.status) where.status = filters.status;
        if (filters?.device) where.device = filters.device;
        if (filters?.search) {
            where.OR = [
                { email: { contains: filters.search, mode: 'insensitive' } },
                { name: { contains: filters.search, mode: 'insensitive' } },
            ];
        }

        return this.prisma.betaTester.findMany({
            where,
            orderBy: { createdAt: 'desc' },
        });
    }

    async updateStatus(id: string, status: string, notes?: string, downloadLink?: string) {
        const tester = await this.prisma.betaTester.findUnique({ where: { id } });
        if (!tester) throw new NotFoundException('Tester no encontrado');

        const updated = await this.prisma.betaTester.update({
            where: { id },
            data: { status, ...(notes !== undefined ? { notes } : {}) },
        });

        // If notified, send email with download instructions
        if (status === 'notified') {
            this.mailService.sendTesterNotificationEmail(
                tester.email,
                tester.name,
                tester.device,
                downloadLink,
            ).catch(() => { /* non-blocking */ });
        }

        // Log to Telegram
        this.telegramService.sendLog('tester.status_changed', {
            name: tester.name,
            email: tester.email,
            status,
        } as any).catch(() => { /* non-blocking */ });

        return updated;
    }

    async getStats() {
        const [total, pending, approved, notified, active] = await Promise.all([
            this.prisma.betaTester.count(),
            this.prisma.betaTester.count({ where: { status: 'pending' } }),
            this.prisma.betaTester.count({ where: { status: 'approved' } }),
            this.prisma.betaTester.count({ where: { status: 'notified' } }),
            this.prisma.betaTester.count({ where: { status: 'active' } }),
        ]);
        return { total, pending, approved, notified, active };
    }
}
