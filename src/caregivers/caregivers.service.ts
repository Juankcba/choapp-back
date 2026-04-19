import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { isValidCoord } from '../common/coords';
import { jitterCoord } from '../common/jitter';
import { findProvince, isInProvince } from '../common/provinces';
import { effectiveActivationStatus, isActiveCaregiver } from '../common/activation';
import { MatchingService } from '../matching/matching.service';

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
    private readonly logger = new Logger(CaregiversService.name);

    constructor(
        private prisma: PrismaService,
        private matchingService: MatchingService,
    ) { }

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

    /**
     * Perfil del cuidador destinado a una familia que ya tiene relación con
     * él (match interesado o cuidador asignado). A diferencia del público,
     * NO filtra `isTestAccount`: la familia tiene que poder ver el perfil
     * del cuidador que está considerando o con el que ya acordó, aunque la
     * cuenta sea de prueba (ej: en staging o la primera ronda de betas).
     */
    async getProfileForFamily(caregiverId: string, familyUserId: string) {
        const family = await this.prisma.family.findUnique({
            where: { userId: familyUserId },
            select: { id: true },
        });
        if (!family) throw new NotFoundException('Family profile not found');

        // Validar relación: la familia interactuó con este cuidador (al menos
        // una ServiceNotification) o le asignó un service.
        const [notifCount, assignedCount] = await Promise.all([
            this.prisma.serviceNotification.count({
                where: {
                    caregiverId,
                    service: { familyId: family.id },
                },
            }),
            this.prisma.service.count({
                where: { caregiverId, familyId: family.id },
            }),
        ]);
        if (notifCount === 0 && assignedCount === 0) {
            // La familia no debería poder escrapear perfiles arbitrarios con
            // este endpoint. Si no hay relación, respondemos como si no
            // existiera — mismo shape que el público.
            throw new NotFoundException('Caregiver not found');
        }

        // Reuso del builder del perfil, pero sin filtrar test accounts.
        return this.buildCaregiverProfile(caregiverId, { allowTestAccount: true });
    }

    async getPublicProfile(caregiverId: string) {
        return this.buildCaregiverProfile(caregiverId, { allowTestAccount: false });
    }

    private async buildCaregiverProfile(
        caregiverId: string,
        opts: { allowTestAccount: boolean },
    ) {
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
                activationStatus: true,
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
        if (!user) throw new NotFoundException('Caregiver not found');
        if (!opts.allowTestAccount && user.isTestAccount) {
            throw new NotFoundException('Caregiver not found');
        }

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
            activationStatus: effectiveActivationStatus(caregiver),
            // Legacy, kept during migration. Prefer `activationStatus`.
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
        // Validar payment schemes. `upfront_full` siempre está presente (el
        // sistema no funciona sin al menos uno). Sanitizamos quitando duplicados
        // y valores fuera del enum.
        if (data.paymentSchemes !== undefined) {
            if (!Array.isArray(data.paymentSchemes)) {
                throw new BadRequestException('paymentSchemes debe ser un array');
            }
            const allowed = new Set(['upfront_full', 'per_session']);
            const clean = Array.from(new Set(
                data.paymentSchemes.filter((s: unknown) => typeof s === 'string' && allowed.has(s))
            )) as string[];
            if (!clean.includes('upfront_full')) clean.unshift('upfront_full');
            mappedData.paymentSchemes = clean;
        }

        // Snapshot del estado previo para detectar cambios relevantes para el
        // re-matching (cuidador que recién ahora es candidato a un service ya
        // publicado).
        const previous = await this.prisma.caregiver.findUnique({
            where: { userId },
            select: {
                id: true,
                specialties: true,
                locationLat: true,
                locationLng: true,
                isAvailable: true,
            },
        });

        const updated = await this.prisma.caregiver.upsert({
            where: { userId },
            update: mappedData,
            create: { userId, ...mappedData },
        });

        // Re-match solo si hubo cambio real en specialties o en coordenadas.
        // Evita disparar re-matching en updates que tocan bio / tarifa / banco.
        const prevSpecialties = (previous?.specialties ?? []).slice().sort().join(',');
        const nextSpecialties = (updated.specialties ?? []).slice().sort().join(',');
        const specialtiesChanged = prevSpecialties !== nextSpecialties;
        const locationChanged = (previous?.locationLat ?? null) !== (updated.locationLat ?? null)
            || (previous?.locationLng ?? null) !== (updated.locationLng ?? null);
        const justBecameAvailable = previous?.isAvailable === false && updated.isAvailable === true;

        if (specialtiesChanged || locationChanged || justBecameAvailable) {
            this.matchingService.rematchForCaregiver(updated.id)
                .then(r => this.logger.log(
                    `Rematch cuidador ${updated.id}: escaneados=${r.scanned}, notificados=${r.notified}`,
                ))
                .catch(err => this.logger.error(
                    `rematchForCaregiver failed for ${updated.id}`, err as Error,
                ));
        }

        return updated;
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
            if (!isActiveCaregiver(caregiver)) {
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
                activationStatus: true,
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
        // SEO sitemap: surface caregivers that are KYC-verified and fully activated
        // (registration complete), plus filter out test accounts. During the
        // verificationStatus → activationStatus transition we accept either
        // column as "active" through the helper.
        const caregivers = await this.prisma.caregiver.findMany({
            where: {
                OR: [
                    { activationStatus: 'active' },
                    { AND: [{ activationStatus: 'pending' }, { verificationStatus: 'verified' }] },
                ],
                user: { identityStatus: 'verified' },
            },
            select: {
                id: true,
                activationStatus: true,
                verificationStatus: true,
                locationLat: true,
                locationLng: true,
                updatedAt: true,
                user: { select: { isTestAccount: true } },
            },
        });

        return caregivers
            .filter((c) => c.user.isTestAccount !== true)
            .filter((c) => isActiveCaregiver(c))
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
