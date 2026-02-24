import { Module } from '@nestjs/common';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';
import { PaymentsModule } from '../payments/payments.module';
import { MatchingModule } from '../matching/matching.module';
import { MailModule } from '../mail/mail.module';
import { UsersModule } from '../users/users.module';

@Module({
    imports: [PaymentsModule, MatchingModule, MailModule, UsersModule],
    controllers: [AdminController],
    providers: [AdminService],
})
export class AdminModule { }
