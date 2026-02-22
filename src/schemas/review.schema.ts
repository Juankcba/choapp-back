import { Prop, Schema, SchemaFactory, raw } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ReviewDocument = Review & Document;

@Schema({ timestamps: true })
export class Review {
    _id: Types.ObjectId;

    @Prop({ type: Types.ObjectId, ref: 'Service', required: true })
    serviceId: Types.ObjectId;

    @Prop({ type: Types.ObjectId, ref: 'Family', required: true })
    familyId: Types.ObjectId;

    @Prop({ type: Types.ObjectId, ref: 'Caregiver', required: true })
    caregiverId: Types.ObjectId;

    @Prop({ required: true, min: 1, max: 5 })
    rating: number;

    @Prop({ required: true })
    comment: string;

    @Prop(
        raw({
            professionalism: { type: Number, required: true, min: 1, max: 5 },
            communication: { type: Number, required: true, min: 1, max: 5 },
            punctuality: { type: Number, required: true, min: 1, max: 5 },
            careQuality: { type: Number, required: true, min: 1, max: 5 },
        }),
    )
    categories: {
        professionalism: number;
        communication: number;
        punctuality: number;
        careQuality: number;
    };

    @Prop({ default: true })
    isPublic: boolean;

    @Prop(
        raw({
            comment: String,
            respondedAt: Date,
        }),
    )
    response?: {
        comment: string;
        respondedAt: Date;
    };
}

export const ReviewSchema = SchemaFactory.createForClass(Review);
ReviewSchema.index({ caregiverId: 1 });
ReviewSchema.index({ serviceId: 1 });
ReviewSchema.index({ familyId: 1 });
ReviewSchema.index({ rating: -1 });
