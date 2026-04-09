import { Controller, Get, Post, Put, Delete, Body, Param, UseGuards } from '@nestjs/common';
import { PressService } from './press.service';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard } from '../auth/roles.guard';
import { Public } from '../auth/decorators';

@Controller('press')
export class PressController {
    constructor(private readonly pressService: PressService) { }

    @Public()
    @Get()
    async findAll() {
        return this.pressService.findAll();
    }

    @Get(':id')
    @UseGuards(AuthGuard('jwt'), RolesGuard)
    async findById(@Param('id') id: string) {
        return this.pressService.findById(id);
    }

    @Post()
    @UseGuards(AuthGuard('jwt'), RolesGuard)
    async create(@Body() body: {
        title: string;
        summary: string;
        content?: string;
        imageUrl?: string;
        publishedAt: string;
    }) {
        return this.pressService.create(body);
    }

    @Put(':id')
    @UseGuards(AuthGuard('jwt'), RolesGuard)
    async update(@Param('id') id: string, @Body() body: any) {
        return this.pressService.update(id, body);
    }

    @Delete(':id')
    @UseGuards(AuthGuard('jwt'), RolesGuard)
    async delete(@Param('id') id: string) {
        return this.pressService.delete(id);
    }
}
