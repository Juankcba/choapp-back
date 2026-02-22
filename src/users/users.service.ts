import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User, UserDocument } from '../schemas/user.schema';

@Injectable()
export class UsersService {
    constructor(
        @InjectModel(User.name) private userModel: Model<UserDocument>,
    ) { }

    async findById(id: string) {
        const user = await this.userModel.findById(id).select('-password').lean();
        if (!user) throw new NotFoundException('Usuario no encontrado');
        return user;
    }

    async updateProfile(
        id: string,
        updateData: Partial<{ firstName: string; lastName: string; phone: string; profileImage: string }>,
    ) {
        const user = await this.userModel
            .findByIdAndUpdate(id, updateData, { new: true })
            .select('-password')
            .lean();
        if (!user) throw new NotFoundException('Usuario no encontrado');
        return user;
    }
}
