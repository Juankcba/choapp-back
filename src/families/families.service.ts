import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class FamiliesService {
    constructor(private prisma: PrismaService) { }

    async getProfile(userId: string) {
        const family = await this.prisma.family.findUnique({
            where: { userId },
            include: { user: { select: { email: true, firstName: true, lastName: true, phone: true, image: true } } },
        });
        if (!family) throw new NotFoundException('Family profile not found');
        return family;
    }

    async updateProfile(userId: string, data: any) {
        return this.prisma.family.update({
            where: { userId },
            data,
        });
    }
}
