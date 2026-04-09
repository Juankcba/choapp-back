import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class CareersService {
    constructor(private prisma: PrismaService) { }

    async findAll(activeOnly = false) {
        const where = activeOnly ? { isActive: true } : {};
        return this.prisma.jobPosting.findMany({
            where,
            orderBy: { createdAt: 'desc' },
        });
    }

    async findById(id: string) {
        const job = await this.prisma.jobPosting.findUnique({ where: { id } });
        if (!job) throw new NotFoundException('Job posting not found');
        return job;
    }

    async create(data: {
        title: string;
        type: string;
        location: string;
        description: string;
        requirements?: string;
        isActive?: boolean;
    }) {
        return this.prisma.jobPosting.create({ data });
    }

    async update(id: string, data: Partial<{
        title: string;
        type: string;
        location: string;
        description: string;
        requirements: string;
        isActive: boolean;
    }>) {
        await this.findById(id);
        return this.prisma.jobPosting.update({ where: { id }, data });
    }

    async delete(id: string) {
        await this.findById(id);
        return this.prisma.jobPosting.delete({ where: { id } });
    }
}
