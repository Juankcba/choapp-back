import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { User, UserSchema } from '../schemas/user.schema';
import { Caregiver, CaregiverSchema } from '../schemas/caregiver.schema';
import { Family, FamilySchema } from '../schemas/family.schema';
import { Service, ServiceSchema } from '../schemas/service.schema';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';

@Module({
    imports: [
        MongooseModule.forFeature([
            { name: User.name, schema: UserSchema },
            { name: Caregiver.name, schema: CaregiverSchema },
            { name: Family.name, schema: FamilySchema },
            { name: Service.name, schema: ServiceSchema },
        ]),
    ],
    controllers: [AdminController],
    providers: [AdminService],
})
export class AdminModule { }
