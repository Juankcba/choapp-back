import { Controller, Get, Post, Body, Param } from '@nestjs/common';
import { ReviewsService } from './reviews.service';

@Controller('reviews')
export class ReviewsController {
    constructor(private readonly reviewsService: ReviewsService) { }

    @Post()
    async create(@Body() body: any) {
        return this.reviewsService.create(body);
    }

    @Get('caregiver/:caregiverId')
    async findByCaregiver(@Param('caregiverId') caregiverId: string) {
        return this.reviewsService.findByCaregiver(caregiverId);
    }
}
