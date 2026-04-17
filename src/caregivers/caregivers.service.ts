import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

const CREDENTIAL_KINDS = ['certification', 'course', 'experience'] as const;
type CredentialKind = typeof CREDENTIAL_KINDS[number];

interface CredentialInput {
    kind: CredentialKind;
    title: string;
    institution?: string;
    description?: string;
    issueDate?: string;
    expiresAt?: string;
    hours?: number;
    fileUrl?: string;
    fileName?: string;
    fileType?: string;
}

@Injectable()
export class CaregiversService {
    constructor(private prisma: PrismaService) { }

    async getProfile(userId: string) {
        const caregiver = await this.prisma.caregiver.findUnique({
            where: { userId },
            include: { user: { select: { email: true, firstName: true, lastName: true, phone: true, image: true } } },
        });
        if (!caregiver) throw new NotFoundException('Caregiver profile not found');
        return caregiver;
    }

    async getPublicProfile(caregiverId: string) {
        const caregiver = await this.prisma.caregiver.findUnique({
            where: { id: caregiverId },
            include: {
                user: { select: { firstName: true, lastName: true, name: true, image: true } },
                reviews: {
                    where: { reviewType: 'family_to_caregiver' },
                    orderBy: { createdAt: 'desc' },
                    take: 10,
                    select: {
                        id: true,
                        rating: true,
                        comment: true,
                        createdAt: true,
                        reviewer: { select: { firstName: true, lastName: true, name: true } },
                    },
                },
            },
        });
        if (!caregiver) throw new NotFoundException('Caregiver not found');

        return {
            id: caregiver.id,
            firstName: caregiver.user.firstName,
            lastName: caregiver.user.lastName,
            name: caregiver.user.name,
            image: caregiver.user.image,
            bio: caregiver.bio,
            specialties: caregiver.specialties,
            experience: caregiver.experience,
            hourlyRate: caregiver.hourlyRate,
            rating: caregiver.rating,
            totalReviews: caregiver.totalReviews,
            totalServices: caregiver.totalServices,
            verificationStatus: caregiver.verificationStatus,
            certifications: caregiver.certifications || [],
            reviews: caregiver.reviews,
        };
    }

    async updateProfile(userId: string, data: any) {
        const mappedData: any = {};

        if (data.bio !== undefined) mappedData.bio = data.bio;
        if (data.experience !== undefined) mappedData.experience = data.experience;
        if (data.hourlyRate !== undefined) mappedData.hourlyRate = data.hourlyRate;
        if (data.specialties) mappedData.specialties = data.specialties;
        if (data.locationLat !== undefined) mappedData.locationLat = data.locationLat;
        if (data.locationLng !== undefined) mappedData.locationLng = data.locationLng;
        if (data.currentLocation?.lat !== undefined) mappedData.locationLat = data.currentLocation.lat;
        if (data.currentLocation?.lng !== undefined) mappedData.locationLng = data.currentLocation.lng;
        if (data.isAvailable !== undefined) mappedData.isAvailable = data.isAvailable;
        if (data.bankCbu !== undefined) mappedData.bankCbu = data.bankCbu;
        if (data.bankAlias !== undefined) mappedData.bankAlias = data.bankAlias;
        if (data.bankName !== undefined) mappedData.bankName = data.bankName;

        return this.prisma.caregiver.upsert({
            where: { userId },
            update: mappedData,
            create: { userId, ...mappedData },
        });
    }

    async updateAvailability(userId: string, isAvailable: boolean) {
        return this.prisma.caregiver.update({
            where: { userId },
            data: { isAvailable },
        });
    }

    async getJobs(userId: string) {
        const caregiver = await this.prisma.caregiver.findUnique({ where: { userId } });
        if (!caregiver) throw new NotFoundException('Caregiver not found');

        return this.prisma.service.findMany({
            where: {
                OR: [
                    { caregiverId: caregiver.id },
                    { status: 'pending', caregiverId: null },
                ],
            },
            include: {
                family: {
                    include: { user: { select: { firstName: true, lastName: true, phone: true } } },
                },
            },
            orderBy: { createdAt: 'desc' },
        });
    }

    async acceptJob(userId: string, serviceId: string) {
        const caregiver = await this.prisma.caregiver.findUnique({ where: { userId } });
        if (!caregiver) throw new NotFoundException('Caregiver not found');

        return this.prisma.service.update({
            where: { id: serviceId },
            data: { caregiverId: caregiver.id, status: 'accepted' },
        });
    }

    async completeJob(userId: string, serviceId: string) {
        const caregiver = await this.prisma.caregiver.findUnique({ where: { userId } });
        if (!caregiver) throw new NotFoundException('Caregiver not found');

        const service = await this.prisma.service.update({
            where: { id: serviceId },
            data: { status: 'completed', actualEnd: new Date() },
        });

        await this.prisma.caregiver.update({
            where: { id: caregiver.id },
            data: { totalServices: { increment: 1 } },
        });

        return service;
    }

    async addCredential(userId: string, input: CredentialInput) {
        if (!input?.kind || !CREDENTIAL_KINDS.includes(input.kind)) {
            throw new BadRequestException('Tipo de credencial invalido');
        }
        if (!input.title || !input.title.trim()) {
            throw new BadRequestException('El titulo es obligatorio');
        }

        const caregiver = await this.prisma.caregiver.findUnique({ where: { userId } });
        if (!caregiver) throw new NotFoundException('Caregiver not found');

        const credential = {
            id: randomUUID(),
            kind: input.kind,
            title: input.title.trim(),
            institution: input.institution?.trim() || null,
            description: input.description?.trim() || null,
            issueDate: input.issueDate || null,
            expiresAt: input.expiresAt || null,
            hours: typeof input.hours === 'number' ? input.hours : null,
            fileUrl: input.fileUrl || null,
            fileName: input.fileName || null,
            fileType: input.fileType || null,
            createdAt: new Date().toISOString(),
        };

        const existing = (caregiver.certifications || []) as any[];
        const updated = [...existing, credential];

        await this.prisma.caregiver.update({
            where: { userId },
            data: { certifications: updated },
        });

        return credential;
    }

    async deleteCredential(userId: string, credentialId: string) {
        const caregiver = await this.prisma.caregiver.findUnique({ where: { userId } });
        if (!caregiver) throw new NotFoundException('Caregiver not found');

        const existing = (caregiver.certifications || []) as any[];
        const updated = existing.filter((c) => c?.id !== credentialId);

        if (updated.length === existing.length) {
            throw new NotFoundException('Credential not found');
        }

        await this.prisma.caregiver.update({
            where: { userId },
            data: { certifications: updated },
        });

        return { success: true };
    }
}
