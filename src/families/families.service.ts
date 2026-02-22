import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class FamiliesService {
    constructor(private prisma: PrismaService) { }

    async getProfile(userId: string) {
        const family = await this.prisma.family.findUnique({
            where: { userId },
            include: { user: { select: { email: true, firstName: true, lastName: true, phone: true, image: true, name: true } } },
        });
        if (!family) throw new NotFoundException('Family profile not found');
        return family;
    }

    async updateProfile(userId: string, data: any) {
        // Map nested data to flat schema fields
        const mappedData: any = {};

        if (data.address) mappedData.address = data.address;
        if (data.locationLat !== undefined) mappedData.locationLat = data.locationLat;
        if (data.locationLng !== undefined) mappedData.locationLng = data.locationLng;
        if (data.location?.lat !== undefined) mappedData.locationLat = data.location.lat;
        if (data.location?.lng !== undefined) mappedData.locationLng = data.location.lng;
        if (data.emergencyContactName) mappedData.emergencyContactName = data.emergencyContactName;
        if (data.emergencyContactPhone) mappedData.emergencyContactPhone = data.emergencyContactPhone;
        if (data.emergencyContactRel) mappedData.emergencyContactRel = data.emergencyContactRel;
        if (data.emergencyContact?.name) mappedData.emergencyContactName = data.emergencyContact.name;
        if (data.emergencyContact?.phone) mappedData.emergencyContactPhone = data.emergencyContact.phone;
        if (data.emergencyContact?.relationship) mappedData.emergencyContactRel = data.emergencyContact.relationship;

        return this.prisma.family.upsert({
            where: { userId },
            update: mappedData,
            create: { userId, ...mappedData },
        });
    }
}
