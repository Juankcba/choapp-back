import { Controller, Get, Post, Put, Delete, Body, Param, Query, UseGuards } from '@nestjs/common';
import { CareersService } from './careers.service';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard } from '../auth/roles.guard';
import { Public } from '../auth/decorators';

@Controller('careers')
export class CareersController {
    constructor(private readonly careersService: CareersService) { }

    @Public()
    @Get()
    async findAll(@Query('active') active?: string) {
        const activeOnly = active !== 'false';
        return this.careersService.findAll(activeOnly);
    }

    @Get(':id')
    @UseGuards(AuthGuard('jwt'), RolesGuard)
    async findById(@Param('id') id: string) {
        return this.careersService.findById(id);
    }

    @Post()
    @UseGuards(AuthGuard('jwt'), RolesGuard)
    async create(@Body() body: {
        title: string;
        type: string;
        location: string;
        description: string;
        requirements?: string;
        isActive?: boolean;
    }) {
        return this.careersService.create(body);
    }

    @Put(':id')
    @UseGuards(AuthGuard('jwt'), RolesGuard)
    async update(@Param('id') id: string, @Body() body: any) {
        return this.careersService.update(id, body);
    }

    @Delete(':id')
    @UseGuards(AuthGuard('jwt'), RolesGuard)
    async delete(@Param('id') id: string) {
        return this.careersService.delete(id);
    }
}
