import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PressService {
    constructor(private prisma: PrismaService) { }

    async findAll() {
        return this.prisma.pressRelease.findMany({
            orderBy: { publishedAt: 'desc' },
        });
    }

    async findById(id: string) {
        const pr = await this.prisma.pressRelease.findUnique({ where: { id } });
        if (!pr) throw new NotFoundException('Press release not found');
        return pr;
    }

    async create(data: {
        title: string;
        summary: string;
        content?: string;
        imageUrl?: string;
        publishedAt: string;
    }) {
        return this.prisma.pressRelease.create({
            data: {
                ...data,
                publishedAt: new Date(data.publishedAt),
            },
        });
    }

    async update(id: string, data: Partial<{
        title: string;
        summary: string;
        content: string;
        imageUrl: string;
        publishedAt: string;
    }>) {
        await this.findById(id);
        const updateData: any = { ...data };
        if (data.publishedAt) {
            updateData.publishedAt = new Date(data.publishedAt);
        }
        return this.prisma.pressRelease.update({ where: { id }, data: updateData });
    }

    async delete(id: string) {
        await this.findById(id);
        return this.prisma.pressRelease.delete({ where: { id } });
    }
}
