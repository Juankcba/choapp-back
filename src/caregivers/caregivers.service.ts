import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Caregiver, CaregiverDocument } from '../schemas/caregiver.schema';
import { User, UserDocument } from '../schemas/user.schema';
import { Service, ServiceDocument } from '../schemas/service.schema';

@Injectable()
export class CaregiversService {
    constructor(
        @InjectModel(Caregiver.name)
        private caregiverModel: Model<CaregiverDocument>,
        @InjectModel(User.name) private userModel: Model<UserDocument>,
        @InjectModel(Service.name) private serviceModel: Model<ServiceDocument>,
    ) { }

    async getProfile(userId: string) {
        const caregiver = await this.caregiverModel
            .findOne({ userId })
            .populate('userId', '-password')
            .lean();
        if (!caregiver)
            throw new NotFoundException('Perfil de cuidador no encontrado');
        return caregiver;
    }

    async updateProfile(userId: string, updateData: any) {
        const caregiver = await this.caregiverModel
            .findOneAndUpdate({ userId }, updateData, { new: true })
            .lean();
        if (!caregiver)
            throw new NotFoundException('Perfil de cuidador no encontrado');
        return caregiver;
    }

    async updateAvailability(userId: string, isAvailable: boolean) {
        const caregiver = await this.caregiverModel.findOneAndUpdate(
            { userId },
            { 'availability.isAvailable': isAvailable },
            { new: true },
        );
        if (!caregiver)
            throw new NotFoundException('Perfil de cuidador no encontrado');
        return { isAvailable: caregiver.availability.isAvailable };
    }

    async getJobs(userId: string) {
        const caregiver = await this.caregiverModel.findOne({ userId });
        if (!caregiver)
            throw new NotFoundException('Perfil de cuidador no encontrado');

        const availableJobs = await this.serviceModel
            .find({
                matchedCaregiversIds: caregiver._id,
                caregiverId: { $exists: false },
                status: { $in: ['pending', 'matched'] },
                rejectedByCaregiversIds: { $ne: caregiver._id },
                scheduledDate: { $gte: new Date() },
            })
            .sort({ createdAt: -1 })
            .lean();

        const myJobs = await this.serviceModel
            .find({
                caregiverId: caregiver._id,
                status: { $in: ['accepted', 'in_progress', 'completed'] },
            })
            .sort({ scheduledDate: -1 })
            .lean();

        return { availableJobs, myJobs };
    }

    async acceptJob(userId: string, serviceId: string) {
        const caregiver = await this.caregiverModel.findOne({ userId });
        if (!caregiver)
            throw new NotFoundException('Perfil de cuidador no encontrado');

        const service = await this.serviceModel.findById(serviceId);
        if (!service)
            throw new NotFoundException('Servicio no encontrado');

        service.caregiverId = caregiver._id;
        service.status = 'accepted';
        await service.save();

        return { message: 'Trabajo aceptado exitosamente', service };
    }

    async completeJob(userId: string, serviceId: string) {
        const caregiver = await this.caregiverModel.findOne({ userId });
        if (!caregiver)
            throw new NotFoundException('Perfil de cuidador no encontrado');

        const service = await this.serviceModel.findOne({
            _id: serviceId,
            caregiverId: caregiver._id,
        });
        if (!service)
            throw new NotFoundException('Servicio no encontrado');

        service.status = 'completed';
        service.endTime = new Date();
        service.paymentStatus = 'paid';
        await service.save();

        // Update caregiver stats
        caregiver.totalServices += 1;
        caregiver.earnings.total += service.totalAmount;
        caregiver.earnings.available += service.totalAmount;
        await caregiver.save();

        return { message: 'Servicio completado', service };
    }
}
