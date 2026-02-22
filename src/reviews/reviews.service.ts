import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Review, ReviewDocument } from '../schemas/review.schema';
import { Caregiver, CaregiverDocument } from '../schemas/caregiver.schema';

@Injectable()
export class ReviewsService {
    constructor(
        @InjectModel(Review.name) private reviewModel: Model<ReviewDocument>,
        @InjectModel(Caregiver.name)
        private caregiverModel: Model<CaregiverDocument>,
    ) { }

    async create(createReviewDto: any) {
        const review = await this.reviewModel.create(createReviewDto);

        // Update caregiver rating
        const reviews = await this.reviewModel.find({
            caregiverId: createReviewDto.caregiverId,
        });
        const avgRating =
            reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length;

        await this.caregiverModel.findByIdAndUpdate(createReviewDto.caregiverId, {
            rating: Math.round(avgRating * 10) / 10,
            totalReviews: reviews.length,
        });

        return review;
    }

    async findByCaregiver(caregiverId: string) {
        return this.reviewModel
            .find({ caregiverId, isPublic: true })
            .populate({
                path: 'familyId',
                populate: { path: 'userId', select: 'firstName lastName' },
            })
            .sort({ createdAt: -1 })
            .lean();
    }
}
