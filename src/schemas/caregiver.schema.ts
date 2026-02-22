import { Prop, Schema, SchemaFactory, raw } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type CaregiverDocument = Caregiver & Document;

@Schema({ timestamps: true })
export class Caregiver {
    _id: Types.ObjectId;

    @Prop({ type: Types.ObjectId, ref: 'User', required: true, unique: true })
    userId: Types.ObjectId;

    @Prop({ required: true, default: '' })
    bio: string;

    @Prop({
        type: [String],
        enum: [
            'elderly_care',
            'special_needs',
            'alzheimers',
            'physical_therapy',
            'medication_management',
            'companionship',
            'personal_care',
            'dementia_care',
        ],
    })
    specialties: string[];

    @Prop({ required: true, min: 0, default: 0 })
    experience: number;

    @Prop({
        type: [
            {
                name: String,
                issuer: String,
                issueDate: Date,
                expiryDate: Date,
                documentUrl: String,
            },
        ],
        default: [],
    })
    certifications: Array<{
        name: string;
        issuer: string;
        issueDate: Date;
        expiryDate?: Date;
        documentUrl: string;
    }>;

    @Prop({
        type: [
            {
                type: {
                    type: String,
                    enum: ['id', 'background_check', 'medical_certificate', 'reference'],
                    required: true,
                },
                url: { type: String, required: true },
                uploadedAt: { type: Date, default: Date.now },
                verifiedAt: Date,
                verifiedBy: { type: Types.ObjectId, ref: 'User' },
                status: {
                    type: String,
                    enum: ['pending', 'approved', 'rejected'],
                    default: 'pending',
                },
            },
        ],
        default: [],
    })
    documents: Array<{
        type: string;
        url: string;
        uploadedAt: Date;
        verifiedAt?: Date;
        verifiedBy?: Types.ObjectId;
        status: string;
    }>;

    @Prop({ default: 0, min: 0, max: 5 })
    rating: number;

    @Prop({ default: 0 })
    totalReviews: number;

    @Prop({ default: 0 })
    totalServices: number;

    @Prop(
        raw({
            type: { type: String, enum: ['Point'] },
            coordinates: { type: [Number] },
        }),
    )
    currentLocation?: {
        type: string;
        coordinates: [number, number];
    };

    @Prop(
        raw({
            isAvailable: { type: Boolean, default: true },
            schedule: [
                {
                    day: {
                        type: String,
                        enum: [
                            'monday',
                            'tuesday',
                            'wednesday',
                            'thursday',
                            'friday',
                            'saturday',
                            'sunday',
                        ],
                    },
                    startTime: String,
                    endTime: String,
                },
            ],
        }),
    )
    availability: {
        isAvailable: boolean;
        schedule: Array<{ day: string; startTime: string; endTime: string }>;
    };

    @Prop({ default: 30000 })
    serviceRadius: number;

    @Prop({ required: true, min: 0, default: 0 })
    hourlyRate: number;

    @Prop({
        enum: ['pending', 'verified', 'rejected'],
        default: 'pending',
    })
    verificationStatus: string;

    @Prop(
        raw({
            accountNumber: String,
            routingNumber: String,
            accountHolderName: String,
        }),
    )
    bankAccount?: {
        accountNumber: string;
        routingNumber: string;
        accountHolderName: string;
    };

    @Prop(
        raw({
            total: { type: Number, default: 0 },
            pending: { type: Number, default: 0 },
            available: { type: Number, default: 0 },
        }),
    )
    earnings: {
        total: number;
        pending: number;
        available: number;
    };
}

export const CaregiverSchema = SchemaFactory.createForClass(Caregiver);
CaregiverSchema.index({ currentLocation: '2dsphere' });
CaregiverSchema.index({ userId: 1 });
CaregiverSchema.index({ verificationStatus: 1 });
CaregiverSchema.index({ 'availability.isAvailable': 1 });
CaregiverSchema.index({ rating: -1 });
