import { Prop, Schema, SchemaFactory, raw } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ServiceDocument = Service & Document;

@Schema({ timestamps: true })
export class Service {
    _id: Types.ObjectId;

    @Prop({ type: Types.ObjectId, ref: 'Family', required: true })
    familyId: Types.ObjectId;

    @Prop({ type: Types.ObjectId, ref: 'Caregiver' })
    caregiverId?: Types.ObjectId;

    @Prop({
        required: true,
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
    serviceType: string;

    @Prop(
        raw({
            name: { type: String, required: true },
            age: { type: Number, required: true },
            condition: { type: String, required: true },
            specialNeeds: { type: String, required: true },
        }),
    )
    patientInfo: {
        name: string;
        age: number;
        condition: string;
        specialNeeds: string;
    };

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

    @Prop({ required: true })
    address: string;

    @Prop({ required: true })
    scheduledDate: Date;

    @Prop({ required: true, min: 1 })
    duration: number;

    @Prop({
        enum: [
            'pending',
            'matched',
            'accepted',
            'in_progress',
            'completed',
            'cancelled',
        ],
        default: 'pending',
    })
    status: string;

    @Prop({ required: true })
    hourlyRate: number;

    @Prop({ required: true })
    totalAmount: number;

    @Prop({ required: true, enum: ['card', 'cash'] })
    paymentMethod: string;

    @Prop({ enum: ['pending', 'paid', 'failed'], default: 'pending' })
    paymentStatus: string;

    @Prop()
    cashCode?: string;

    @Prop({ type: [{ type: Types.ObjectId, ref: 'Caregiver' }], default: [] })
    matchedCaregiversIds: Types.ObjectId[];

    @Prop({ type: [{ type: Types.ObjectId, ref: 'Caregiver' }], default: [] })
    rejectedByCaregiversIds: Types.ObjectId[];

    @Prop()
    startTime?: Date;

    @Prop()
    endTime?: Date;

    @Prop()
    notes?: string;

    @Prop()
    cancellationReason?: string;
}

export const ServiceSchema = SchemaFactory.createForClass(Service);
ServiceSchema.index({ location: '2dsphere' });
ServiceSchema.index({ familyId: 1 });
ServiceSchema.index({ caregiverId: 1 });
ServiceSchema.index({ status: 1 });
ServiceSchema.index({ scheduledDate: 1 });
