import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class BlogService {
    constructor(private prisma: PrismaService) { }

    async findAll(publishedOnly = false) {
        const where = publishedOnly ? { published: true } : {};
        return this.prisma.blogPost.findMany({
            where,
            orderBy: { createdAt: 'desc' },
        });
    }

    async findBySlug(slug: string) {
        const post = await this.prisma.blogPost.findUnique({ where: { slug } });
        if (!post) throw new NotFoundException('Post not found');
        return post;
    }

    async findById(id: string) {
        const post = await this.prisma.blogPost.findUnique({ where: { id } });
        if (!post) throw new NotFoundException('Post not found');
        return post;
    }

    async create(data: {
        title: string;
        slug: string;
        excerpt: string;
        content: string;
        imageUrl?: string;
        category: string;
        authorName: string;
        published?: boolean;
    }) {
        return this.prisma.blogPost.create({
            data: {
                ...data,
                publishedAt: data.published ? new Date() : undefined,
            },
        });
    }

    async update(id: string, data: Partial<{
        title: string;
        slug: string;
        excerpt: string;
        content: string;
        imageUrl: string;
        category: string;
        authorName: string;
        published: boolean;
    }>) {
        await this.findById(id);
        const updateData: any = { ...data };
        if (data.published === true) {
            updateData.publishedAt = new Date();
        }
        return this.prisma.blogPost.update({ where: { id }, data: updateData });
    }

    async delete(id: string) {
        await this.findById(id);
        return this.prisma.blogPost.delete({ where: { id } });
    }
}
