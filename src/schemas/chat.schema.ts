import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ChatDocument = Chat & Document;

@Schema({ _id: false })
export class Message {
    @Prop({ type: Types.ObjectId, ref: 'User', required: true })
    senderId: Types.ObjectId;

    @Prop({ required: true })
    content: string;

    @Prop({ default: Date.now })
    timestamp: Date;

    @Prop({ default: false })
    isRead: boolean;
}

export const MessageSchema = SchemaFactory.createForClass(Message);

@Schema({ timestamps: true })
export class Chat {
    _id: Types.ObjectId;

    @Prop({ type: Types.ObjectId, ref: 'Service', required: true })
    serviceId: Types.ObjectId;

    @Prop({ type: Types.ObjectId, ref: 'Family', required: true })
    familyId: Types.ObjectId;

    @Prop({ type: Types.ObjectId, ref: 'Caregiver', required: true })
    caregiverId: Types.ObjectId;

    @Prop({ type: [MessageSchema], default: [] })
    messages: Message[];

    @Prop({
        type: {
            content: String,
            timestamp: Date,
            senderId: { type: Types.ObjectId, ref: 'User' },
        },
    })
    lastMessage?: {
        content: string;
        timestamp: Date;
        senderId: Types.ObjectId;
    };
}

export const ChatSchema = SchemaFactory.createForClass(Chat);
ChatSchema.index({ serviceId: 1 });
ChatSchema.index({ familyId: 1 });
ChatSchema.index({ caregiverId: 1 });
ChatSchema.index({ 'lastMessage.timestamp': -1 });
