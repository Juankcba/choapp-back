import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MedixalinkService } from './medixalink.service';

// Apartado del código dedicado a la integración con medixalink (producto
// hermano de Bladelink Company). Hoy cubre videollamadas; si mañana medixalink
// expone más servicios al resto de Bladelink, se agregan acá.
@Module({
    imports: [ConfigModule],
    providers: [MedixalinkService],
    exports: [MedixalinkService],
})
export class MedixalinkModule { }
