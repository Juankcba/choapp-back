import { Module } from '@nestjs/common';
import { TestersService } from './testers.service';
import { TestersController } from './testers.controller';
import { MailModule } from '../mail/mail.module';

@Module({
    imports: [MailModule],
    controllers: [TestersController],
    providers: [TestersService],
    exports: [TestersService],
})
export class TestersModule { }
