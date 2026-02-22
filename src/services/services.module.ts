import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Service, ServiceSchema } from '../schemas/service.schema';
import { Family, FamilySchema } from '../schemas/family.schema';
import { Caregiver, CaregiverSchema } from '../schemas/caregiver.schema';
import { User, UserSchema } from '../schemas/user.schema';
import { ServicesService } from './services.service';
import { ServicesController } from './services.controller';

@Module({
    imports: [
        MongooseModule.forFeature([
            { name: Service.name, schema: ServiceSchema },
            { name: Family.name, schema: FamilySchema },
            { name: Caregiver.name, schema: CaregiverSchema },
            { name: User.name, schema: UserSchema },
        ]),
    ],
    controllers: [ServicesController],
    providers: [ServicesService],
    exports: [ServicesService],
})
export class ServicesModule { }
