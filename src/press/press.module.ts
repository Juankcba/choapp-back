import { Module } from '@nestjs/common';
import { PressService } from './press.service';
import { PressController } from './press.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
    imports: [PrismaModule],
    controllers: [PressController],
    providers: [PressService],
    exports: [PressService],
})
export class PressModule { }
