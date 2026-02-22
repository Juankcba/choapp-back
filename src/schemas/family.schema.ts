import { Prop, Schema, SchemaFactory, raw } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type FamilyDocument = Family & Document;

@Schema({ timestamps: true })
export class Family {
    _id: Types.ObjectId;

    @Prop({ type: Types.ObjectId, ref: 'User', required: true, unique: true })
    userId: Types.ObjectId;

    @Prop({ required: true })
    address: string;

    @Prop(
        raw({
            type: { type: String, enum: ['Point'], required: true },
            coordinates: { type: [Number], required: true },
        }),
    )
    location: {
        type: string;
        coordinates: [number, number];
    };

    @Prop(
        raw({
            name: { type: String, required: true },
            phone: { type: String, required: true },
            relationship: { type: String, required: true },
        }),
    )
    emergencyContact: {
        name: string;
        phone: string;
        relationship: string;
    };

    @Prop({
        type: [
            {
                type: {
                    type: String,
                    enum: ['card', 'cash'],
                    required: true,
                },
                isDefault: { type: Boolean, default: false },
                last4: String,
                stripePaymentMethodId: String,
            },
        ],
        default: [],
    })
    paymentMethods: Array<{
        type: string;
        isDefault: boolean;
        last4?: string;
        stripePaymentMethodId?: string;
    }>;

    @Prop({ type: [{ type: Types.ObjectId, ref: 'Service' }], default: [] })
    serviceHistory: Types.ObjectId[];

    @Prop({ type: [{ type: Types.ObjectId, ref: 'Caregiver' }], default: [] })
    favoriteCaregiversIds: Types.ObjectId[];
}

export const FamilySchema = SchemaFactory.createForClass(Family);
FamilySchema.index({ location: '2dsphere' });
FamilySchema.index({ userId: 1 });
