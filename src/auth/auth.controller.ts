import { Controller, Post, Body, Req, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { RegisterDto, LoginDto } from './dto/auth.dto';
import { Public } from './decorators';
import { AuthGuard } from '@nestjs/passport';

@Controller('auth')
export class AuthController {
    constructor(private readonly authService: AuthService) { }

    @Public()
    @Post('register')
    async register(@Body() registerDto: RegisterDto) {
        return this.authService.register(registerDto);
    }

    @Public()
    @Post('login')
    async login(@Body() loginDto: LoginDto) {
        return this.authService.login(loginDto);
    }

    @Public()
    @Post('validate')
    async validate(@Body() loginDto: LoginDto) {
        const user = await this.authService.validateUser(
            loginDto.email,
            loginDto.password,
        );
        if (!user) {
            return { valid: false };
        }
        return { valid: true, user };
    }

    @Public()
    @Post('social-login')
    async socialLogin(
        @Body() body: { email: string; name?: string; image?: string },
    ) {
        return this.authService.socialLogin(body);
    }

    @Post('set-role')
    @UseGuards(AuthGuard('jwt'))
    async setRole(
        @Req() req: any,
        @Body() body: { role: 'family' | 'caregiver' },
    ) {
        return this.authService.setRole(req.user.userId, body.role);
    }

    @Public()
    @Post('forgot-password')
    async forgotPassword(@Body() body: { email: string }) {
        return this.authService.forgotPassword(body.email);
    }

    @Public()
    @Post('reset-password')
    async resetPassword(@Body() body: { token: string; password: string }) {
        return this.authService.resetPassword(body.token, body.password);
    }
}
