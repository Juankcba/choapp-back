import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Chat, ChatDocument } from '../schemas/chat.schema';

@Injectable()
export class ChatService {
    constructor(
        @InjectModel(Chat.name) private chatModel: Model<ChatDocument>,
    ) { }

    async findOrCreateByService(
        serviceId: string,
        familyId: string,
        caregiverId: string,
    ) {
        let chat = await this.chatModel.findOne({ serviceId }).lean();

        if (!chat) {
            chat = (
                await this.chatModel.create({
                    serviceId: new Types.ObjectId(serviceId),
                    familyId: new Types.ObjectId(familyId),
                    caregiverId: new Types.ObjectId(caregiverId),
                    messages: [],
                })
            ).toObject();
        }

        return chat;
    }

    async getMessages(serviceId: string) {
        const chat = await this.chatModel.findOne({ serviceId }).lean();
        if (!chat) return { messages: [] };
        return chat;
    }

    async addMessage(
        serviceId: string,
        senderId: string,
        content: string,
    ) {
        const message = {
            senderId: new Types.ObjectId(senderId),
            content,
            timestamp: new Date(),
            isRead: false,
        };

        const chat = await this.chatModel.findOneAndUpdate(
            { serviceId },
            {
                $push: { messages: message },
                $set: {
                    lastMessage: {
                        content,
                        timestamp: new Date(),
                        senderId: new Types.ObjectId(senderId),
                    },
                },
            },
            { new: true },
        );

        if (!chat) throw new NotFoundException('Chat no encontrado');

        return message;
    }

    async markAsRead(serviceId: string, userId: string) {
        await this.chatModel.updateOne(
            { serviceId },
            {
                $set: {
                    'messages.$[elem].isRead': true,
                },
            },
            {
                arrayFilters: [
                    {
                        'elem.senderId': { $ne: new Types.ObjectId(userId) },
                        'elem.isRead': false,
                    },
                ],
            },
        );
        return { success: true };
    }
}
