import { Controller, Get, Post, Put, Delete, Body, Param, Query, UseGuards } from '@nestjs/common';
import { BlogService } from './blog.service';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard } from '../auth/roles.guard';
import { Public } from '../auth/decorators';

@Controller('blog')
export class BlogController {
    constructor(private readonly blogService: BlogService) { }

    // Public: get published posts
    @Public()
    @Get()
    async findAll(@Query('published') published?: string) {
        const publishedOnly = published !== 'false';
        return this.blogService.findAll(publishedOnly);
    }

    // Public: get post by slug
    @Public()
    @Get('slug/:slug')
    async findBySlug(@Param('slug') slug: string) {
        return this.blogService.findBySlug(slug);
    }

    // Admin: get post by id
    @Get(':id')
    @UseGuards(AuthGuard('jwt'), RolesGuard)
    async findById(@Param('id') id: string) {
        return this.blogService.findById(id);
    }

    // Admin: create
    @Post()
    @UseGuards(AuthGuard('jwt'), RolesGuard)
    async create(@Body() body: {
        title: string;
        slug: string;
        excerpt: string;
        content: string;
        imageUrl?: string;
        category: string;
        authorName: string;
        published?: boolean;
    }) {
        return this.blogService.create(body);
    }

    // Admin: update
    @Put(':id')
    @UseGuards(AuthGuard('jwt'), RolesGuard)
    async update(@Param('id') id: string, @Body() body: any) {
        return this.blogService.update(id, body);
    }

    // Admin: delete
    @Delete(':id')
    @UseGuards(AuthGuard('jwt'), RolesGuard)
    async delete(@Param('id') id: string) {
        return this.blogService.delete(id);
    }
}
