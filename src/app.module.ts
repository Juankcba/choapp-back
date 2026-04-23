import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from './prisma/prisma.module';
import { MailModule } from './mail/mail.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { CaregiversModule } from './caregivers/caregivers.module';
import { FamiliesModule } from './families/families.module';
import { ServicesModule } from './services/services.module';
import { ChatModule } from './chat/chat.module';
import { ReviewsModule } from './reviews/reviews.module';
import { AdminModule } from './admin/admin.module';
import { MatchingModule } from './matching/matching.module';
// PaymentsModule eliminado el 2026-04-19 junto con la integración de
// MercadoPago. CHO dejó de intermediar pagos: familia y cuidador acuerdan
// precio y lo gestionan directamente entre ellos.
import { CronModule } from './cron/cron.module';
import { BlogModule } from './blog/blog.module';
import { CareersModule } from './careers/careers.module';
import { PressModule } from './press/press.module';
import { VerificationModule } from './verification/verification.module';
import { TelegramModule } from './telegram/telegram.module';
import { TestersModule } from './testers/testers.module';
import { QueueModule } from './queue/queue.module';
import { MedixalinkModule } from './medixalink/medixalink.module';
import { VideoSessionsModule } from './video-sessions/video-sessions.module';
import { CommonModule } from './common/common.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    CommonModule,
    TelegramModule,
    PrismaModule,
    UsersModule,
    QueueModule,
    MailModule,
    AuthModule,
    CaregiversModule,
    FamiliesModule,
    ServicesModule,
    ChatModule,
    ReviewsModule,
    AdminModule,
    MatchingModule,
    CronModule,
    BlogModule,
    CareersModule,
    PressModule,
    VerificationModule,
    TestersModule,
    MedixalinkModule,
    VideoSessionsModule,
  ],
})
export class AppModule { }
