import { Controller, Get, Post, Body, Param, Req } from '@nestjs/common';
import { ReviewsService } from './reviews.service';

@Controller('reviews')
export class ReviewsController {
    constructor(private readonly reviewsService: ReviewsService) { }

    @Post()
    async create(@Req() req: any, @Body() body: any) {
        return this.reviewsService.create(req.user.userId, body);
    }

    @Get('service/:serviceId')
    async findByServiceId(@Param('serviceId') serviceId: string) {
        return this.reviewsService.findByServiceId(serviceId);
    }

    @Get('caregiver/:caregiverId')
    async findByCaregiverId(@Param('caregiverId') caregiverId: string) {
        return this.reviewsService.findByCaregiverId(caregiverId);
    }

    @Get('family/:familyId')
    async findByFamilyId(@Param('familyId') familyId: string) {
        return this.reviewsService.findByFamilyId(familyId);
    }
}
