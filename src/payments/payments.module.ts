import { Module } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { PaymentsController } from './payments.controller';
import { MatchingModule } from '../matching/matching.module';
import { MailModule } from '../mail/mail.module';

@Module({
    imports: [MatchingModule, MailModule],
    controllers: [PaymentsController],
    providers: [PaymentsService],
    exports: [PaymentsService],
})
export class PaymentsModule { }
