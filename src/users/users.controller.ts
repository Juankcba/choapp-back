import { Controller, Get, Patch, Body, Req } from '@nestjs/common';

import { UsersService } from './users.service';

@Controller('users')
export class UsersController {
    constructor(private readonly usersService: UsersService) { }

    @Get('me')
    async getMe(@Req() req: any) {
        return this.usersService.findById(req.user.userId);
    }

    @Patch('me')
    async updateMe(
        @Req() req: any,
        @Body() body: { firstName?: string; lastName?: string; phone?: string; profileImage?: string },
    ) {
        return this.usersService.updateProfile(req.user.userId, body);
    }
}
