import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User, UserDocument } from '../schemas/user.schema';
import { Caregiver, CaregiverDocument } from '../schemas/caregiver.schema';
import { Family, FamilyDocument } from '../schemas/family.schema';
import { Service, ServiceDocument } from '../schemas/service.schema';

@Injectable()
export class AdminService {
    constructor(
        @InjectModel(User.name) private userModel: Model<UserDocument>,
        @InjectModel(Caregiver.name)
        private caregiverModel: Model<CaregiverDocument>,
        @InjectModel(Family.name) private familyModel: Model<FamilyDocument>,
        @InjectModel(Service.name) private serviceModel: Model<ServiceDocument>,
    ) { }

    async getStats() {
        const [
            totalUsers,
            totalCaregivers,
            totalFamilies,
            pendingVerifications,
            activeServices,
            completedServices,
        ] = await Promise.all([
            this.userModel.countDocuments(),
            this.caregiverModel.countDocuments(),
            this.familyModel.countDocuments(),
            this.caregiverModel.countDocuments({ verificationStatus: 'pending' }),
            this.serviceModel.countDocuments({
                status: { $in: ['pending', 'matched', 'accepted', 'in_progress'] },
            }),
            this.serviceModel.countDocuments({ status: 'completed' }),
        ]);

        const revenueResult = await this.serviceModel.aggregate([
            { $match: { status: 'completed' } },
            { $group: { _id: null, total: { $sum: '$totalAmount' } } },
        ]);
        const totalRevenue = revenueResult[0]?.total || 0;

        return {
            totalUsers,
            totalCaregivers,
            totalFamilies,
            pendingVerifications,
            activeServices,
            completedServices,
            totalRevenue,
        };
    }

    async getPendingCaregivers() {
        return this.caregiverModel
            .find({ verificationStatus: 'pending' })
            .populate('userId', '-password')
            .sort({ createdAt: -1 })
            .lean();
    }

    async verifyCaregiver(caregiverId: string, approved: boolean) {
        const caregiver = await this.caregiverModel.findByIdAndUpdate(
            caregiverId,
            {
                verificationStatus: approved ? 'verified' : 'rejected',
            },
            { new: true },
        );
        if (!caregiver)
            throw new NotFoundException('Cuidador no encontrado');

        return {
            message: approved ? 'Cuidador verificado' : 'Cuidador rechazado',
            caregiver,
        };
    }

    async getActiveServices() {
        return this.serviceModel
            .find({
                status: { $in: ['pending', 'matched', 'accepted', 'in_progress'] },
            })
            .populate({
                path: 'familyId',
                populate: { path: 'userId', select: 'firstName lastName' },
            })
            .populate({
                path: 'caregiverId',
                populate: { path: 'userId', select: 'firstName lastName' },
            })
            .sort({ createdAt: -1 })
            .lean();
    }
}
