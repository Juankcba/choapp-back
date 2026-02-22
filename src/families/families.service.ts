import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Family, FamilyDocument } from '../schemas/family.schema';

@Injectable()
export class FamiliesService {
    constructor(
        @InjectModel(Family.name) private familyModel: Model<FamilyDocument>,
    ) { }

    async getProfile(userId: string) {
        const family = await this.familyModel
            .findOne({ userId })
            .populate('userId', '-password')
            .lean();
        if (!family) throw new NotFoundException('Perfil familiar no encontrado');
        return family;
    }

    async updateProfile(userId: string, updateData: any) {
        const family = await this.familyModel
            .findOneAndUpdate({ userId }, updateData, { new: true })
            .lean();
        if (!family) throw new NotFoundException('Perfil familiar no encontrado');
        return family;
    }
}
