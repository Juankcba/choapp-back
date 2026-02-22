import { Controller, Get, Post, Body, Param, Req } from '@nestjs/common';
import { ReviewsService } from './reviews.service';

@Controller('reviews')
export class ReviewsController {
    constructor(private readonly reviewsService: ReviewsService) { }

    @Post()
    async create(@Req() req: any, @Body() body: any) {
        return this.reviewsService.create(req.user.userId, body);
    }

    @Get('caregiver/:caregiverId')
    async findByCaregiverId(@Param('caregiverId') caregiverId: string) {
        return this.reviewsService.findByCaregiverId(caregiverId);
    }
}
