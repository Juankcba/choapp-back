import { Module } from '@nestjs/common';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';
import { MatchingModule } from '../matching/matching.module';
import { MailModule } from '../mail/mail.module';
import { UsersModule } from '../users/users.module';
import { TestersModule } from '../testers/testers.module';

// PaymentsModule fue eliminado junto con todo el flow de MercadoPago
// (2026-04-19). CHO pasó a ser plataforma de conexión sin intermediar
// pagos: familia y cuidador acuerdan directamente.
@Module({
    imports: [MatchingModule, MailModule, UsersModule, TestersModule],
    controllers: [AdminController],
    providers: [AdminService],
})
export class AdminModule { }
