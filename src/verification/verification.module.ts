import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { VerificationService } from './verification.service';
import { VerificationController } from './verification.controller';
import { MatchingModule } from '../matching/matching.module';
import { UsersModule } from '../users/users.module';

@Module({
    imports: [HttpModule, MatchingModule, UsersModule],
    controllers: [VerificationController],
    providers: [VerificationService],
    exports: [VerificationService],
})
export class VerificationModule { }
