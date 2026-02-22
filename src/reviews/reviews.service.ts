import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ReviewsService {
    constructor(private prisma: PrismaService) { }

    async create(reviewerId: string, data: any) {
        const review = await this.prisma.review.create({
            data: {
                serviceId: data.serviceId,
                caregiverId: data.caregiverId,
                reviewerId,
                rating: data.rating,
                comment: data.comment,
            },
        });

        // Update caregiver rating
        const reviews = await this.prisma.review.findMany({
            where: { caregiverId: data.caregiverId },
        });
        const avgRating = reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length;

        await this.prisma.caregiver.update({
            where: { id: data.caregiverId },
            data: {
                rating: avgRating,
                totalReviews: reviews.length,
            },
        });

        return review;
    }

    async findByCaregiverId(caregiverId: string) {
        return this.prisma.review.findMany({
            where: { caregiverId },
            include: { reviewer: { select: { firstName: true, lastName: true, image: true } } },
            orderBy: { createdAt: 'desc' },
        });
    }
}
