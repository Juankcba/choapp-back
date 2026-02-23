import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ChatService {
    constructor(private prisma: PrismaService) { }

    /**
     * Find or create a 1v1 chat between a service and a specific caregiver.
     */
    async findOrCreateChat(serviceId: string, caregiverId: string) {
        let chat = await this.prisma.chat.findFirst({
            where: { serviceId, caregiverId },
        });

        if (!chat) {
            chat = await this.prisma.chat.create({
                data: {
                    serviceId,
                    caregiverId,
                    messages: [],
                },
            });
        }

        return chat;
    }

    async getMessages(serviceId: string, caregiverId: string) {
        const chat = await this.prisma.chat.findFirst({
            where: { serviceId, caregiverId },
        });
        if (!chat) return [];
        return chat.messages;
    }

    async addMessage(serviceId: string, caregiverId: string, senderId: string, content: string) {
        const chat = await this.findOrCreateChat(serviceId, caregiverId);

        const newMessage = {
            senderId,
            content,
            timestamp: new Date(),
            read: false,
        };

        await this.prisma.chat.update({
            where: { id: chat.id },
            data: {
                messages: {
                    push: newMessage,
                },
            },
        });

        return newMessage;
    }

    async markAsRead(serviceId: string, caregiverId: string, userId: string) {
        const chat = await this.prisma.chat.findFirst({ where: { serviceId, caregiverId } });
        if (!chat) throw new NotFoundException('Chat not found');

        const updatedMessages = chat.messages.map((msg) => {
            if (msg.senderId !== userId && !msg.read) {
                return { ...msg, read: true };
            }
            return msg;
        });

        return this.prisma.chat.update({
            where: { id: chat.id },
            data: { messages: updatedMessages },
        });
    }

    /**
     * Get all chats for a service (admin use)
     */
    async getChatsByService(serviceId: string) {
        return this.prisma.chat.findMany({
            where: { serviceId },
            include: {
                caregiver: { include: { user: { select: { firstName: true, lastName: true, name: true } } } },
            },
        });
    }
}
