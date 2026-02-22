import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Service, ServiceDocument } from '../schemas/service.schema';
import { Family, FamilyDocument } from '../schemas/family.schema';
import { Caregiver, CaregiverDocument } from '../schemas/caregiver.schema';
import { User, UserDocument } from '../schemas/user.schema';

@Injectable()
export class ServicesService {
    constructor(
        @InjectModel(Service.name) private serviceModel: Model<ServiceDocument>,
        @InjectModel(Family.name) private familyModel: Model<FamilyDocument>,
        @InjectModel(Caregiver.name) private caregiverModel: Model<CaregiverDocument>,
        @InjectModel(User.name) private userModel: Model<UserDocument>,
    ) { }

    async create(userId: string, createServiceDto: any) {
        const family = await this.familyModel.findOne({ userId });
        if (!family) throw new NotFoundException('Perfil familiar no encontrado');

        const {
            serviceType,
            patientInfo,
            scheduledDate,
            duration,
            paymentMethod,
            notes,
        } = createServiceDto;

        // Find available caregivers within 30km radius
        let caregivers: CaregiverDocument[] = [];
        try {
            caregivers = await this.caregiverModel
                .find({
                    verificationStatus: 'verified',
                    'availability.isAvailable': true,
                    specialties: serviceType,
                    currentLocation: {
                        $near: {
                            $geometry: family.location,
                            $maxDistance: 30000,
                        },
                    },
                })
                .limit(10);
        } catch {
            // If geospatial query fails (no 2dsphere index or no location data), get all available
            caregivers = await this.caregiverModel
                .find({
                    verificationStatus: 'verified',
                    'availability.isAvailable': true,
                    specialties: serviceType,
                })
                .limit(10);
        }

        const averageRate =
            caregivers.length > 0
                ? caregivers.reduce((sum, c) => sum + c.hourlyRate, 0) /
                caregivers.length
                : 25000;

        const totalAmount = averageRate * duration;
        const cashCode =
            paymentMethod === 'cash'
                ? Math.floor(100000 + Math.random() * 900000).toString()
                : undefined;

        const service = await this.serviceModel.create({
            familyId: family._id,
            serviceType,
            patientInfo,
            location: family.location,
            address: family.address,
            scheduledDate,
            duration,
            status: caregivers.length > 0 ? 'matched' : 'pending',
            hourlyRate: averageRate,
            totalAmount,
            paymentMethod,
            paymentStatus: 'pending',
            cashCode,
            matchedCaregiversIds: caregivers.map((c) => c._id),
            rejectedByCaregiversIds: [],
            notes,
        });

        return {
            message: 'Solicitud creada exitosamente',
            serviceId: service._id,
            matchedCaregiversCount: caregivers.length,
        };
    }

    async findByFamily(userId: string) {
        const family = await this.familyModel.findOne({ userId });
        if (!family) throw new NotFoundException('Perfil familiar no encontrado');

        const services = await this.serviceModel
            .find({ familyId: family._id })
            .populate({
                path: 'caregiverId',
                populate: { path: 'userId', select: 'firstName lastName' },
            })
            .sort({ createdAt: -1 })
            .lean();

        // Transform to add caregiver name info to each service
        return services.map((s: any) => {
            const caregiver = s.caregiverId;
            return {
                ...s,
                caregiver: caregiver
                    ? {
                        firstName: caregiver.userId?.firstName || '',
                        lastName: caregiver.userId?.lastName || '',
                        rating: caregiver.rating,
                    }
                    : undefined,
                caregiverId: caregiver?._id,
            };
        });
    }

    async findById(id: string) {
        const service = await this.serviceModel
            .findById(id)
            .populate({
                path: 'caregiverId',
                populate: { path: 'userId', select: 'firstName lastName profileImage' },
            })
            .populate({
                path: 'familyId',
                populate: { path: 'userId', select: 'firstName lastName' },
            })
            .lean();
        if (!service) throw new NotFoundException('Servicio no encontrado');
        return service;
    }

    async acceptCaregiver(serviceId: string, userId: string) {
        const family = await this.familyModel.findOne({ userId });
        if (!family) throw new NotFoundException('Perfil familiar no encontrado');

        const service = await this.serviceModel.findOne({
            _id: serviceId,
            familyId: family._id,
        });
        if (!service) throw new NotFoundException('Servicio no encontrado');

        service.status = 'in_progress';
        service.startTime = new Date();
        await service.save();

        return { message: 'Cuidador aceptado', service };
    }
}
