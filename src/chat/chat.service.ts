import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ChatService {
    constructor(private prisma: PrismaService) { }

    async findOrCreateChat(serviceId: string) {
        let chat = await this.prisma.chat.findFirst({
            where: { serviceId },
        });

        if (!chat) {
            chat = await this.prisma.chat.create({
                data: {
                    serviceId,
                    messages: [],
                },
            });
        }

        return chat;
    }

    async getMessages(serviceId: string) {
        const chat = await this.prisma.chat.findFirst({
            where: { serviceId },
        });
        if (!chat) return [];
        return chat.messages;
    }

    async addMessage(serviceId: string, senderId: string, content: string) {
        let chat = await this.findOrCreateChat(serviceId);

        const newMessage = {
            senderId,
            content,
            timestamp: new Date(),
            read: false,
        };

        chat = await this.prisma.chat.update({
            where: { id: chat.id },
            data: {
                messages: {
                    push: newMessage,
                },
            },
        });

        return newMessage;
    }

    async markAsRead(serviceId: string, userId: string) {
        const chat = await this.prisma.chat.findFirst({ where: { serviceId } });
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
}
