import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ReviewsService {
    constructor(private prisma: PrismaService) { }

    /**
     * Create a review — supports both directions:
     *   family → caregiver  (reviewType = 'family_to_caregiver')
     *   caregiver → family  (reviewType = 'caregiver_to_family')
     */
    async create(reviewerId: string, data: any) {
        const service = await this.prisma.service.findUnique({
            where: { id: data.serviceId },
            include: {
                family: true,
                caregiver: true,
            },
        });
        if (!service) throw new NotFoundException('Service not found');
        if (service.status !== 'completed') throw new BadRequestException('Service must be completed to review');

        const reviewType = data.reviewType || 'family_to_caregiver';

        // Check if review already exists for this direction
        const existing = await this.prisma.review.findFirst({
            where: { serviceId: data.serviceId, reviewerId, reviewType },
        });
        if (existing) throw new BadRequestException('Ya dejaste una reseña para este servicio');

        let reviewData: any = {
            serviceId: data.serviceId,
            reviewerId,
            reviewType,
            rating: data.rating,
            comment: data.comment || null,
        };

        if (reviewType === 'family_to_caregiver') {
            reviewData.caregiverId = service.caregiverId;
        } else {
            reviewData.familyId = service.familyId;
        }

        const review = await this.prisma.review.create({ data: reviewData });

        // Update aggregate rating on the target
        if (reviewType === 'family_to_caregiver' && service.caregiverId) {
            const reviews = await this.prisma.review.findMany({
                where: { caregiverId: service.caregiverId, reviewType: 'family_to_caregiver' },
            });
            const avgRating = reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length;
            await this.prisma.caregiver.update({
                where: { id: service.caregiverId },
                data: { rating: avgRating, totalReviews: reviews.length },
            });
        }

        return review;
    }

    async findByCaregiverId(caregiverId: string) {
        return this.prisma.review.findMany({
            where: { caregiverId, reviewType: 'family_to_caregiver' },
            include: { reviewer: { select: { firstName: true, lastName: true, name: true, image: true } } },
            orderBy: { createdAt: 'desc' },
        });
    }

    async findByFamilyId(familyId: string) {
        return this.prisma.review.findMany({
            where: { familyId, reviewType: 'caregiver_to_family' },
            include: { reviewer: { select: { firstName: true, lastName: true, name: true, image: true } } },
            orderBy: { createdAt: 'desc' },
        });
    }

    async findByServiceId(serviceId: string) {
        return this.prisma.review.findMany({
            where: { serviceId },
            include: { reviewer: { select: { firstName: true, lastName: true, name: true, image: true } } },
            orderBy: { createdAt: 'desc' },
        });
    }

    async getAverageRating(targetId: string, type: 'caregiver' | 'family') {
        const where = type === 'caregiver'
            ? { caregiverId: targetId, reviewType: 'family_to_caregiver' }
            : { familyId: targetId, reviewType: 'caregiver_to_family' };

        const reviews = await this.prisma.review.findMany({ where });
        if (reviews.length === 0) return { average: 0, count: 0 };

        const avg = reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length;
        return { average: Math.round(avg * 10) / 10, count: reviews.length };
    }
}
