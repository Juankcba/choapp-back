import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Family, FamilySchema } from '../schemas/family.schema';
import { FamiliesService } from './families.service';
import { FamiliesController } from './families.controller';

@Module({
    imports: [
        MongooseModule.forFeature([{ name: Family.name, schema: FamilySchema }]),
    ],
    controllers: [FamiliesController],
    providers: [FamiliesService],
    exports: [FamiliesService],
})
export class FamiliesModule { }
