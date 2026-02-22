import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Caregiver, CaregiverSchema } from '../schemas/caregiver.schema';
import { User, UserSchema } from '../schemas/user.schema';
import { Service, ServiceSchema } from '../schemas/service.schema';
import { CaregiversService } from './caregivers.service';
import { CaregiversController } from './caregivers.controller';

@Module({
    imports: [
        MongooseModule.forFeature([
            { name: Caregiver.name, schema: CaregiverSchema },
            { name: User.name, schema: UserSchema },
            { name: Service.name, schema: ServiceSchema },
        ]),
    ],
    controllers: [CaregiversController],
    providers: [CaregiversService],
    exports: [CaregiversService],
})
export class CaregiversModule { }
