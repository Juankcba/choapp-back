import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { isValidCoord } from '../common/coords';
import { jitterCoord } from '../common/jitter';
import { findProvince, isInProvince } from '../common/provinces';

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
            include: {
                user: {
                    select: {
                        email: true,
                        firstName: true,
                        lastName: true,
                        phone: true,
                        image: true,
                        identityStatus: true,
                    },
                },
            },
        });
        if (!caregiver) throw new NotFoundException('Caregiver profile not found');
        return caregiver;
    }

    async getPublicProfile(caregiverId: string) {
        const caregiver = await this.prisma.caregiver.findUnique({
            where: { id: caregiverId },
            select: {
                id: true,
                userId: true,
                bio: true,
                specialties: true,
                experience: true,
                hourlyRate: true,
                rating: true,
                totalReviews: true,
                totalServices: true,
                verificationStatus: true,
                certifications: true,
            },
        });
        if (!caregiver) throw new NotFoundException('Caregiver not found');

        // Fetch user separately (referential integrity isn't guaranteed in Mongo)
        const user = await this.prisma.user.findUnique({
            where: { id: caregiver.userId },
            select: {
                firstName: true,
                lastName: true,
                name: true,
                image: true,
                isTestAccount: true,
                identityStatus: true,
            },
        });
        if (!user || user.isTestAccount) throw new NotFoundException('Caregiver not found');

        const reviews = await this.prisma.review.findMany({
            where: { caregiverId, reviewType: 'family_to_caregiver' },
            orderBy: { createdAt: 'desc' },
            take: 10,
            select: {
                id: true,
                rating: true,
                comment: true,
                createdAt: true,
                reviewerId: true,
            },
        });

        // Join reviewer names (skip any orphaned reviews)
        const reviewerIds = [...new Set(reviews.map((r) => r.reviewerId))];
        const reviewers = reviewerIds.length
            ? await this.prisma.user.findMany({
                where: { id: { in: reviewerIds } },
                select: { id: true, firstName: true, lastName: true, name: true },
            })
            : [];
        const reviewerById = new Map(reviewers.map((r) => [r.id, r]));

        return {
            id: caregiver.id,
            firstName: user.firstName,
            lastName: user.lastName,
            name: user.name,
            image: user.image,
            bio: caregiver.bio,
            specialties: caregiver.specialties,
            experience: caregiver.experience,
            hourlyRate: caregiver.hourlyRate,
            rating: caregiver.rating,
            totalReviews: caregiver.totalReviews,
            totalServices: caregiver.totalServices,
            verificationStatus: caregiver.verificationStatus,
            // Caregiver completed KYC (DNI) via Didit. This is what the UI should
            // surface as "Identidad verificada" — CHO does NOT vouch for their
            // professional capabilities.
            identityVerified: user.identityStatus === 'verified',
            dniVerified: user.identityStatus === 'verified',
            certifications: caregiver.certifications || [],
            reviews: reviews.map((r) => ({
                id: r.id,
                rating: r.rating,
                comment: r.comment,
                createdAt: r.createdAt,
                reviewer: reviewerById.get(r.reviewerId) || { firstName: null, lastName: null, name: null },
            })),
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
        if (isAvailable) {
            const caregiver = await this.prisma.caregiver.findUnique({
                where: { userId },
                include: { user: { select: { identityStatus: true } } },
            });
            if (!caregiver) throw new NotFoundException('Caregiver not found');

            const reasons: string[] = [];
            if (caregiver.user.identityStatus !== 'verified') {
                reasons.push('Falta validar tu DNI (verificación de identidad)');
            }
            if (caregiver.verificationStatus !== 'verified') {
                reasons.push('Todavía tenés que terminar de completar tu perfil (datos, documentación y ubicación)');
            }
            if (!isValidCoord(caregiver.locationLat, caregiver.locationLng)) {
                reasons.push('Tenés que cargar tu ubicación (coordenadas) en tu perfil');
            }
            if (reasons.length) {
                throw new BadRequestException({
                    message: 'No podés marcarte como disponible todavía',
                    reasons,
                });
            }
        }

        return this.prisma.caregiver.update({
            where: { userId },
            data: { isAvailable },
        });
    }

    async getPublicStats() {
        // MongoDB referential integrity isn't enforced, so some Caregiver rows
        // can point to a deleted User. Selecting through the relation then
        // crashes Prisma. Same pattern as admin.service: pre-fetch valid user
        // IDs and join in JS.
        const users = await this.prisma.user.findMany({
            select: { id: true, identityStatus: true, isTestAccount: true },
        });
        const userById = new Map(users.map((u) => [u.id, u]));

        const rows = await this.prisma.caregiver.findMany({
            where: { userId: { in: users.map((u) => u.id) } },
            select: { id: true, userId: true },
        });

        const allPublic = rows.filter((c) => {
            const u = userById.get(c.userId);
            return u && u.isTestAccount !== true;
        });

        const totalCaregivers = allPublic.length;
        const verifiedCaregivers = allPublic.filter((c) => {
            const u = userById.get(c.userId);
            return u && u.identityStatus === 'verified';
        }).length;

        const allIds = allPublic.map((c) => c.id);
        const reviewAgg = await this.prisma.review.aggregate({
            where: {
                reviewType: 'family_to_caregiver',
                caregiverId: { in: allIds },
            },
            _avg: { rating: true },
            _count: { rating: true },
        });

        const avg = reviewAgg._avg.rating ?? 0;
        const totalReviews = reviewAgg._count.rating ?? 0;

        return {
            totalCaregivers,
            verifiedCaregivers,
            averageRating: Math.round(avg * 10) / 10,
            totalReviews,
        };
    }

    async getPublicSearch(provinceSlug?: string | null) {
        const province = findProvince(provinceSlug);

        // Pre-fetch users separately and join in JS (see getPublicStats — some
        // caregivers in prod have dangling userId and Prisma crashes trying to
        // include the required `user` relation).
        const users = await this.prisma.user.findMany({
            select: {
                id: true,
                firstName: true,
                lastName: true,
                name: true,
                image: true,
                identityStatus: true,
                isTestAccount: true,
            },
        });
        const userById = new Map(users.map((u) => [u.id, u]));

        const caregivers = await this.prisma.caregiver.findMany({
            where: { userId: { in: users.map((u) => u.id) } },
            select: {
                id: true,
                userId: true,
                bio: true,
                specialties: true,
                experience: true,
                hourlyRate: true,
                rating: true,
                totalReviews: true,
                totalServices: true,
                verificationStatus: true,
                locationLat: true,
                locationLng: true,
            },
        });

        const items = caregivers
            .map((c) => ({ c, user: userById.get(c.userId) }))
            .filter(({ user }) => user && user.isTestAccount !== true)
            .filter(({ c }) => isValidCoord(c.locationLat, c.locationLng))
            .filter(({ c }) => (province ? isInProvince(c.locationLat!, c.locationLng!, province) : true))
            .map(({ c, user }) => {
                const { lat, lng } = jitterCoord(c.locationLat!, c.locationLng!, c.id, 3000);
                return {
                    id: c.id,
                    firstName: user!.firstName,
                    name: user!.name,
                    image: user!.image,
                    bio: c.bio,
                    specialties: c.specialties,
                    experience: c.experience,
                    hourlyRate: c.hourlyRate,
                    rating: c.rating,
                    totalReviews: c.totalReviews,
                    totalServices: c.totalServices,
                    identityVerified: user!.identityStatus === 'verified',
                    dniVerified: user!.identityStatus === 'verified',
                    lat,
                    lng,
                };
            });

        return {
            province: province
                ? { slug: province.slug, name: province.name, center: province.center, zoom: province.zoom }
                : null,
            total: items.length,
            caregivers: items,
        };
    }

    async getPublicList() {
        // Strict filter for SEO sitemap: DNI-verified + admin-approved + not test.
        // Test-account filter done in JS for robustness (see getPublicStats).
        const caregivers = await this.prisma.caregiver.findMany({
            where: {
                verificationStatus: 'verified',
                user: { identityStatus: 'verified' },
            },
            select: {
                id: true,
                locationLat: true,
                locationLng: true,
                updatedAt: true,
                user: { select: { isTestAccount: true } },
            },
        });

        return caregivers
            .filter((c) => c.user.isTestAccount !== true)
            .filter((c) => isValidCoord(c.locationLat, c.locationLng))
            .map((c) => ({ id: c.id, updatedAt: c.updatedAt }));
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
