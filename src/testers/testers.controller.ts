import { Controller, Post, Body } from '@nestjs/common';
import { TestersService } from './testers.service';
import { Public } from '../auth/decorators';

@Controller('testers')
export class TestersController {
    constructor(private readonly testersService: TestersService) { }

    @Public()
    @Post('register')
    async register(
        @Body() body: {
            email: string;
            name: string;
            phone?: string;
            device: string;
            googleEmail?: string;
            source: string;
        },
    ) {
        return this.testersService.register(body);
    }
}
