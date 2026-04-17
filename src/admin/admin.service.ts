import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { MatchingGateway } from '../matching/matching.gateway';
import { MailService } from '../mail/mail.service';
import { UsersService } from '../users/users.service';
import { TelegramService } from '../telegram/telegram.service';

@Injectable()
export class AdminService {
    private readonly logger = new Logger(AdminService.name);

    constructor(
        private prisma: PrismaService,
        private matchingGateway: MatchingGateway,
        private mailService: MailService,
        private usersService: UsersService,
        private telegramService: TelegramService,
        private configService: ConfigService,
    ) { }

    async getStats() {
        const [totalUsers, totalCaregivers, totalFamilies, totalServices, activeServices, paidServices, matchedServices] =
            await Promise.all([
                this.prisma.user.count(),
                this.prisma.caregiver.count(),
                this.prisma.family.count(),
                this.prisma.service.count(),
                this.prisma.service.count({ where: { status: { in: ['pending', 'matched', 'accepted', 'inProgress'] } } }),
                this.prisma.service.count({ where: { paymentStatus: { in: ['paid', 'retenido'] } } }),
                this.prisma.service.count({ where: { status: 'matched' } }),
            ]);

        return { totalUsers, totalCaregivers, totalFamilies, totalServices, activeServices, paidServices, matchedServices };
    }

    async getPendingCaregivers() {
        const validUserIds = (await this.prisma.user.findMany({ select: { id: true } })).map(u => u.id);

        return this.prisma.caregiver.findMany({
            where: {
                verificationStatus: 'pending',
                userId: { in: validUserIds },
            },
            include: { user: { select: { email: true, firstName: true, lastName: true, name: true, phone: true, createdAt: true } } },
            orderBy: { createdAt: 'desc' },
        });
    }

    async verifyCaregiver(caregiverId: string, approved: boolean) {
        const caregiver = await this.prisma.caregiver.update({
            where: { id: caregiverId },
            data: { verificationStatus: approved ? 'verified' : 'rejected' },
            include: { user: true },
        });

        // Notify caregiver in real-time
        if (caregiver.user) {
            this.matchingGateway.emitToUser(caregiver.userId, 'account-verified', {
                status: approved ? 'verified' : 'rejected',
                message: approved
                    ? '¡Tu cuenta fue verificada! Ya podés recibir solicitudes de trabajo.'
                    : 'Tu cuenta fue rechazada. Contactá soporte para más información.',
            });

            // Send email notification
            this.mailService.sendAccountVerifiedEmail(
                caregiver.user.email,
                caregiver.user.name || caregiver.user.firstName || 'Cuidador',
                approved,
            ).catch(() => { /* non-blocking */ });

            // Log to Telegram
            this.telegramService.sendLog(approved ? 'caregiver.verified' : 'caregiver.rejected', {
                name: caregiver.user.name || caregiver.user.firstName || 'Cuidador',
                email: caregiver.user.email,
            }).catch(() => { /* non-blocking */ });
        }

        return caregiver;
    }

    // ─── User Management ─────────────────────────

    async getUsers(filters?: { role?: string; isActive?: string; identityStatus?: string; search?: string }) {
        const where: any = {};

        if (filters?.role) where.role = filters.role;
        if (filters?.isActive !== undefined) where.isActive = filters.isActive === 'true';
        if (filters?.identityStatus) where.identityStatus = filters.identityStatus;
        if (filters?.search) {
            where.OR = [
                { email: { contains: filters.search, mode: 'insensitive' } },
                { firstName: { contains: filters.search, mode: 'insensitive' } },
                { lastName: { contains: filters.search, mode: 'insensitive' } },
                { name: { contains: filters.search, mode: 'insensitive' } },
            ];
        }

        const users = await this.prisma.user.findMany({
            where,
            select: {
                id: true,
                email: true,
                firstName: true,
                lastName: true,
                name: true,
                phone: true,
                role: true,
                isActive: true,
                identityStatus: true,
                dni: true,
                image: true,
                createdAt: true,
                lastLogin: true,
                caregiver: {
                    select: {
                        id: true,
                        verificationStatus: true,
                        specialties: true,
                        experience: true,
                        hourlyRate: true,
                        isAvailable: true,
                    },
                },
                family: {
                    select: {
                        id: true,
                        address: true,
                    },
                },
            },
            orderBy: { createdAt: 'desc' },
        });

        // Attach criminal record status for each user
        const userIds = users.map(u => u.id);
        const records = await this.prisma.criminalRecord.findMany({
            where: { userId: { in: userIds } },
            orderBy: { createdAt: 'desc' },
        });

        const now = new Date();
        const recordsByUser = new Map<string, any>();
        for (const r of records) {
            if (!recordsByUser.has(r.userId)) {
                const expires = new Date(r.expiresAt);
                const days = Math.floor((expires.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
                let status: 'vigente' | 'por_vencer' | 'vencido';
                if (days < 0) status = 'vencido';
                else if (days <= 30) status = 'por_vencer';
                else status = 'vigente';
                recordsByUser.set(r.userId, { status, expiresAt: r.expiresAt, daysUntilExpiry: days });
            }
        }

        return users.map(u => ({
            ...u,
            criminalRecord: recordsByUser.get(u.id) || null,
        }));
    }

    async getUserDetail(userId: string) {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: {
                id: true,
                email: true,
                firstName: true,
                lastName: true,
                name: true,
                phone: true,
                role: true,
                isActive: true,
                identityStatus: true,
                dni: true,
                image: true,
                createdAt: true,
                updatedAt: true,
                lastLogin: true,
                diditVerifiedAt: true,
                diditSessionId: true,
                fcmTokens: true,
                caregiver: true,
                family: true,
            },
        });

        if (!user) return null;

        // Build registration steps checklist
        const steps = {
            registered: true,
            roleSelected: user.role !== 'pending',
            onboardingCompleted: false,
            identityVerified: user.identityStatus === 'verified',
            caregiverVerified: false,
        };

        if (user.role === 'caregiver' && user.caregiver) {
            steps.onboardingCompleted = !!(user.caregiver as any).bio || !!(user.caregiver as any).experience;
            steps.caregiverVerified = (user.caregiver as any).verificationStatus === 'verified';
        } else if (user.role === 'family' && user.family) {
            steps.onboardingCompleted = !!(user.family as any).address;
        }

        // Attach criminal records
        const criminalRecords = await this.getCriminalRecords(userId);
        const currentCriminal = await this.getCurrentCriminalRecord(userId);

        return {
            ...user,
            registrationSteps: steps,
            criminalRecords,
            currentCriminalRecord: currentCriminal,
        };
    }

    async toggleUserActive(userId: string) {
        const user = await this.prisma.user.findUnique({ where: { id: userId } });
        if (!user) return null;

        const updated = await this.prisma.user.update({
            where: { id: userId },
            data: { isActive: !user.isActive },
        });

        // Log to Telegram
        this.telegramService.sendLog(updated.isActive ? 'user.activated' : 'user.deactivated', {
            name: updated.name || updated.firstName || updated.email,
            email: updated.email,
            role: updated.role,
        }).catch(() => { /* non-blocking */ });

        return { id: updated.id, isActive: updated.isActive };
    }

    async updateUser(userId: string, data: {
        firstName?: string;
        lastName?: string;
        phone?: string;
        dni?: string;
        identityStatus?: string;
        address?: string;
    }) {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            include: { family: true, caregiver: true },
        });
        if (!user) throw new NotFoundException('Usuario no encontrado');

        // Update User fields
        const userUpdate: any = {};
        if (data.firstName !== undefined) userUpdate.firstName = data.firstName;
        if (data.lastName !== undefined) userUpdate.lastName = data.lastName;
        if (data.phone !== undefined) userUpdate.phone = data.phone;
        if (data.dni !== undefined) userUpdate.dni = data.dni || null;
        if (data.identityStatus !== undefined) {
            userUpdate.identityStatus = data.identityStatus;
            if (data.identityStatus === 'verified' && !user.diditVerifiedAt) {
                userUpdate.diditVerifiedAt = new Date();
            }
        }

        // Recompute "name" from firstName + lastName
        if (data.firstName !== undefined || data.lastName !== undefined) {
            const fn = data.firstName ?? user.firstName ?? '';
            const ln = data.lastName ?? user.lastName ?? '';
            userUpdate.name = `${fn} ${ln}`.trim() || null;
        }

        if (Object.keys(userUpdate).length > 0) {
            await this.prisma.user.update({ where: { id: userId }, data: userUpdate });
        }

        // Update address on Family record if applicable
        if (data.address !== undefined && user.family) {
            await this.prisma.family.update({
                where: { id: user.family.id },
                data: { address: data.address },
            });
        }

        return this.getUserDetail(userId);
    }

    async updateUserRole(userId: string, role: string) {
        const updated = await this.prisma.user.update({
            where: { id: userId },
            data: { role },
        });

        // Ensure profile record exists
        if (role === 'family') {
            const existing = await this.prisma.family.findUnique({ where: { userId } });
            if (!existing) await this.prisma.family.create({ data: { userId } });
        } else if (role === 'caregiver') {
            const existing = await this.prisma.caregiver.findUnique({ where: { userId } });
            if (!existing) await this.prisma.caregiver.create({ data: { userId } });
        }

        return { id: updated.id, role: updated.role };
    }

    async getActiveServices() {
        return this.prisma.service.findMany({
            where: { status: { in: ['pending', 'matched', 'accepted', 'inProgress'] } },
            include: {
                family: { include: { user: { select: { firstName: true, lastName: true, name: true, email: true } } } },
                caregiver: { include: { user: { select: { firstName: true, lastName: true, name: true, email: true } } } },
            },
            orderBy: { createdAt: 'desc' },
        });
    }

    async getAllServices() {
        return this.prisma.service.findMany({
            include: {
                family: { include: { user: { select: { firstName: true, lastName: true, name: true, email: true, phone: true } } } },
                caregiver: {
                    include: {
                        user: { select: { firstName: true, lastName: true, name: true, email: true, phone: true } },
                    },
                },
            },
            orderBy: { createdAt: 'desc' },
            take: 100,
        });
    }

    /**
     * Admin can read any service's chat conversation
     */
    async getServiceChat(serviceId: string) {
        const service = await this.prisma.service.findUnique({
            where: { id: serviceId },
            include: {
                family: { include: { user: { select: { firstName: true, lastName: true, name: true } } } },
                caregiver: { include: { user: { select: { firstName: true, lastName: true, name: true } } } },
            },
        });

        const chat = await this.prisma.chat.findFirst({
            where: { serviceId },
        });

        return {
            service: {
                id: service?.id,
                serviceType: service?.serviceType,
                status: service?.status,
                familyName: service?.family?.user?.name || `${service?.family?.user?.firstName || ''} ${service?.family?.user?.lastName || ''}`.trim(),
                caregiverName: service?.caregiver?.user?.name || `${service?.caregiver?.user?.firstName || ''} ${service?.caregiver?.user?.lastName || ''}`.trim(),
            },
            messages: chat?.messages || [],
        };
    }

    /**
     * Activity log: recent service state changes via notifications
     */
    async getActivityLog(limit: number = 50) {
        const [recentServices, recentNotifications] = await Promise.all([
            this.prisma.service.findMany({
                include: {
                    family: { include: { user: { select: { firstName: true, lastName: true, name: true } } } },
                    caregiver: { include: { user: { select: { firstName: true, lastName: true, name: true } } } },
                },
                orderBy: { updatedAt: 'desc' },
                take: limit,
            }),
            this.prisma.serviceNotification.findMany({
                where: { status: { in: ['interested', 'accepted', 'declined'] } },
                include: {
                    service: { select: { serviceType: true, patientName: true } },
                    caregiver: { include: { user: { select: { firstName: true, lastName: true, name: true } } } },
                },
                orderBy: { respondedAt: 'desc' },
                take: limit,
            }),
        ]);

        return { recentServices, recentNotifications };
    }

    /**
     * Payment stats for admin dashboard
     */
    async getPaymentStats() {
        const services = await this.prisma.service.findMany({
            where: { paymentStatus: { in: ['paid', 'retenido', 'released'] } },
            select: {
                amount: true,
                commissionFamily: true,
                commissionCarer: true,
                netAmount: true,
                paymentStatus: true,
            },
        });

        const totalCollected = services.reduce((sum, s) => sum + (s.amount || 0) + (s.commissionFamily || 0), 0);
        const totalCommissions = services.reduce((sum, s) => sum + (s.commissionFamily || 0) + (s.commissionCarer || 0), 0);
        const totalReleased = services.filter(s => s.paymentStatus === 'released').reduce((sum, s) => sum + (s.netAmount || 0), 0);
        const pendingRelease = services.filter(s => s.paymentStatus === 'retenido' || s.paymentStatus === 'paid').reduce((sum, s) => sum + (s.netAmount || 0), 0);

        return {
            totalCollected,
            totalCommissions,
            totalReleased,
            pendingRelease,
            totalPaidServices: services.length,
        };
    }

    /**
     * Validate coordinates: must be valid numbers within Earth bounds.
     * Also filters obvious noise: (0,0), default Buenos Aires center, swapped lat/lng.
     */
    private isValidCoord(lat: number | null | undefined, lng: number | null | undefined): boolean {
        if (lat == null || lng == null) return false;
        if (typeof lat !== 'number' || typeof lng !== 'number') return false;
        if (isNaN(lat) || isNaN(lng)) return false;
        if (!isFinite(lat) || !isFinite(lng)) return false;

        // Earth bounds
        if (lat < -90 || lat > 90) return false;
        if (lng < -180 || lng > 180) return false;

        // Reject (0, 0) — null island, default value
        if (lat === 0 && lng === 0) return false;

        return true;
    }

    /**
     * Diagnostic: list users with invalid or suspicious coordinates
     */
    async getUsersWithBadCoordinates() {
        const [caregivers, families] = await Promise.all([
            this.prisma.caregiver.findMany({
                where: {
                    OR: [
                        { locationLat: { not: null } },
                        { locationLng: { not: null } },
                    ],
                },
                select: {
                    id: true,
                    userId: true,
                    locationLat: true,
                    locationLng: true,
                    user: { select: { firstName: true, lastName: true, name: true, email: true } },
                },
            }),
            this.prisma.family.findMany({
                where: {
                    OR: [
                        { locationLat: { not: null } },
                        { locationLng: { not: null } },
                    ],
                },
                select: {
                    id: true,
                    userId: true,
                    locationLat: true,
                    locationLng: true,
                    address: true,
                    user: { select: { firstName: true, lastName: true, name: true, email: true } },
                },
            }),
        ]);

        const issues: any[] = [];

        const checkAndPush = (entity: any, type: 'caregiver' | 'family') => {
            const lat = entity.locationLat;
            const lng = entity.locationLng;
            const reasons: string[] = [];

            if (lat == null || lng == null) reasons.push('Falta lat o lng');
            else {
                if (typeof lat !== 'number' || typeof lng !== 'number') reasons.push('No es numero');
                if (isNaN(lat) || isNaN(lng)) reasons.push('NaN');
                if (lat < -90 || lat > 90) reasons.push(`lat fuera de rango (${lat})`);
                if (lng < -180 || lng > 180) reasons.push(`lng fuera de rango (${lng})`);
                if (lat === 0 && lng === 0) reasons.push('Coordenada (0,0) - null island');
                // Argentina sanity check: lat -55 to -21, lng -74 to -53
                if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
                    if (lat > 0 && lng < 0) reasons.push('Posible lat/lng cruzados (esta en N+W, deberia ser S+W para AR)');
                    if (lat < -55 || lat > -21 || lng < -74 || lng > -53) {
                        reasons.push('Fuera de Argentina (puede ser correcto si es otro pais)');
                    }
                }
            }

            if (reasons.length > 0) {
                issues.push({
                    type,
                    id: entity.id,
                    userId: entity.userId,
                    name: entity.user?.name || `${entity.user?.firstName || ''} ${entity.user?.lastName || ''}`.trim() || entity.user?.email,
                    email: entity.user?.email,
                    locationLat: lat,
                    locationLng: lng,
                    address: entity.address,
                    reasons,
                });
            }
        };

        caregivers.forEach(c => checkAndPush(c, 'caregiver'));
        families.forEach(f => checkAndPush(f, 'family'));

        return {
            total: issues.length,
            critical: issues.filter(i => i.reasons.some((r: string) => !r.startsWith('Fuera de Argentina'))).length,
            issues,
        };
    }

    async clearCaregiverLocation(caregiverId: string) {
        return this.prisma.caregiver.update({
            where: { id: caregiverId },
            data: { locationLat: null, locationLng: null },
        });
    }

    async clearFamilyLocation(familyId: string) {
        return this.prisma.family.update({
            where: { id: familyId },
            data: { locationLat: null, locationLng: null },
        });
    }

    async updateCaregiverLocation(caregiverId: string, lat: number, lng: number) {
        if (!this.isValidCoord(lat, lng)) {
            throw new Error('Coordenadas invalidas. Verifica el rango y formato.');
        }
        return this.prisma.caregiver.update({
            where: { id: caregiverId },
            data: { locationLat: lat, locationLng: lng },
        });
    }

    async updateFamilyLocation(familyId: string, lat: number, lng: number) {
        if (!this.isValidCoord(lat, lng)) {
            throw new Error('Coordenadas invalidas. Verifica el rango y formato.');
        }
        return this.prisma.family.update({
            where: { id: familyId },
            data: { locationLat: lat, locationLng: lng },
        });
    }

    /**
     * Map data: services + caregivers + families with locations
     */
    async getMapData() {
        const [services, caregivers, families] = await Promise.all([
            this.prisma.service.findMany({
                where: {
                    serviceLocationLat: { not: null },
                    serviceLocationLng: { not: null },
                },
                select: {
                    id: true,
                    serviceType: true,
                    status: true,
                    paymentStatus: true,
                    patientName: true,
                    serviceAddress: true,
                    serviceLocationLat: true,
                    serviceLocationLng: true,
                    duration: true,
                    amount: true,
                    createdAt: true,
                    family: {
                        include: {
                            user: { select: { id: true, firstName: true, lastName: true, name: true, email: true } },
                        },
                    },
                    caregiver: {
                        include: {
                            user: { select: { id: true, firstName: true, lastName: true, name: true } },
                        },
                    },
                },
                orderBy: { createdAt: 'desc' },
                take: 200,
            }),
            // Show ALL caregivers with location (verified or not)
            this.prisma.caregiver.findMany({
                where: {
                    locationLat: { not: null },
                    locationLng: { not: null },
                },
                select: {
                    id: true,
                    userId: true,
                    locationLat: true,
                    locationLng: true,
                    specialties: true,
                    hourlyRate: true,
                    experience: true,
                    isAvailable: true,
                    verificationStatus: true,
                    user: { select: { id: true, firstName: true, lastName: true, name: true, email: true, phone: true, fcmTokens: true } },
                },
            }),
            // Families with location
            this.prisma.family.findMany({
                where: {
                    locationLat: { not: null },
                    locationLng: { not: null },
                },
                select: {
                    id: true,
                    userId: true,
                    locationLat: true,
                    locationLng: true,
                    address: true,
                    user: { select: { id: true, firstName: true, lastName: true, name: true, email: true, phone: true, fcmTokens: true } },
                },
            }),
        ]);

        // Track skipped entries for diagnostics
        let skippedServices = 0;
        let skippedCaregivers = 0;
        let skippedFamilies = 0;

        const validServices = services
            .filter(s => {
                const ok = this.isValidCoord(s.serviceLocationLat as any, s.serviceLocationLng as any);
                if (!ok) skippedServices++;
                return ok;
            })
            .map(s => ({
                ...s,
                lat: s.serviceLocationLat,
                lng: s.serviceLocationLng,
                familyUserId: s.family?.user?.id,
                familyName: s.family?.user?.name || `${s.family?.user?.firstName || ''} ${s.family?.user?.lastName || ''}`.trim() || 'Familia',
                caregiverName: s.caregiver?.user?.name || `${s.caregiver?.user?.firstName || ''} ${s.caregiver?.user?.lastName || ''}`.trim() || null,
            }));

        const validCaregivers = caregivers
            .filter(c => {
                const ok = this.isValidCoord(c.locationLat as any, c.locationLng as any);
                if (!ok) {
                    skippedCaregivers++;
                    this.logger.warn(`Skipping caregiver ${c.id} (user ${c.userId}) - bad coords: lat=${c.locationLat}, lng=${c.locationLng}`);
                }
                return ok;
            })
            .map(c => ({
                id: c.id,
                userId: c.userId,
                lat: c.locationLat,
                lng: c.locationLng,
                name: c.user?.name || `${c.user?.firstName || ''} ${c.user?.lastName || ''}`.trim() || 'Cuidador',
                email: c.user?.email,
                phone: c.user?.phone,
                specialties: c.specialties || [],
                hourlyRate: c.hourlyRate,
                experience: c.experience,
                isAvailable: c.isAvailable,
                verificationStatus: c.verificationStatus,
                hasPushToken: (c.user?.fcmTokens || []).length > 0,
            }));

        const validFamilies = families
            .filter(f => {
                const ok = this.isValidCoord(f.locationLat as any, f.locationLng as any);
                if (!ok) {
                    skippedFamilies++;
                    this.logger.warn(`Skipping family ${f.id} (user ${f.userId}) - bad coords: lat=${f.locationLat}, lng=${f.locationLng}`);
                }
                return ok;
            })
            .map(f => ({
                id: f.id,
                userId: f.userId,
                lat: f.locationLat,
                lng: f.locationLng,
                name: f.user?.name || `${f.user?.firstName || ''} ${f.user?.lastName || ''}`.trim() || 'Familia',
                email: f.user?.email,
                phone: f.user?.phone,
                address: f.address,
                hasPushToken: (f.user?.fcmTokens || []).length > 0,
            }));

        if (skippedServices + skippedCaregivers + skippedFamilies > 0) {
            this.logger.warn(`getMapData: skipped ${skippedServices} services, ${skippedCaregivers} caregivers, ${skippedFamilies} families with invalid coords`);
        }

        return {
            services: validServices,
            caregivers: validCaregivers,
            families: validFamilies,
            _diagnostics: {
                skippedServices,
                skippedCaregivers,
                skippedFamilies,
            },
        };
    }

    // ─── DNI / Identity (Didit API) ─────────────────────

    async getUserIdentityDocuments(userId: string) {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: {
                id: true,
                email: true,
                firstName: true,
                lastName: true,
                name: true,
                dni: true,
                identityStatus: true,
                diditSessionId: true,
                diditVerifiedAt: true,
            },
        });

        if (!user) {
            throw new NotFoundException('Usuario no encontrado');
        }

        // If no Didit session, return only basic data
        if (!user.diditSessionId) {
            return {
                ...user,
                hasDocuments: false,
                error: 'Usuario no inicio verificacion via Didit',
            };
        }

        // Fetch session decision from Didit
        const apiKey = this.configService.get<string>('DIDIT_API_KEY') || '';
        if (!apiKey) {
            return { ...user, hasDocuments: false, error: 'DIDIT_API_KEY no configurada' };
        }

        try {
            // Helper: detect UUID format (session_id is a UUID)
            const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
            const looksLikeUuid = uuidRegex.test(user.diditSessionId);

            let sessionIdToQuery = user.diditSessionId;

            // If we don't have a UUID stored (old data with session_token), try to find the session
            // by querying the sessions list filtered by vendor_data (= userId)
            if (!looksLikeUuid) {
                this.logger.log(`Stored sessionId is not UUID, searching by vendor_data for user ${userId}`);
                try {
                    const searchUrl = `https://verification.didit.me/v3/sessions/?vendor_data=${userId}`;
                    const searchRes = await fetch(searchUrl, {
                        headers: { 'x-api-key': apiKey, 'Accept': 'application/json' },
                    });
                    if (searchRes.ok) {
                        const searchData = await searchRes.json();
                        const sessions = searchData?.results || searchData?.sessions || searchData;
                        const verified = Array.isArray(sessions)
                            ? sessions.find((s: any) => s.status === 'Approved' || s.status === 'In Review')
                            : null;
                        if (verified?.session_id || verified?.id) {
                            sessionIdToQuery = verified.session_id || verified.id;
                            // Persist for future calls
                            await this.prisma.user.update({
                                where: { id: userId },
                                data: { diditSessionId: sessionIdToQuery },
                            });
                        }
                    }
                } catch (e) {
                    this.logger.warn(`Search by vendor_data failed: ${(e as any).message}`);
                }
            }

            const url = `https://verification.didit.me/v3/session/${sessionIdToQuery}/decision/`;
            const res = await fetch(url, {
                headers: { 'x-api-key': apiKey, 'Accept': 'application/json' },
            });

            if (!res.ok) {
                this.logger.warn(`Didit decision fetch failed for user ${userId}: ${res.status} (sessionId: ${sessionIdToQuery})`);
                const errorMsg = res.status === 404
                    ? 'Sesion no encontrada en Didit. El usuario puede tener un sessionId obsoleto.'
                    : `Didit API error: ${res.status}`;
                return { ...user, hasDocuments: false, error: errorMsg };
            }

            const data = await res.json();

            // Per Didit v3 docs, top-level response fields:
            // - id_verification: { front_image, back_image, portrait_image, full_front_image, full_back_image, ...ocr fields }
            // - liveness: { image, video_url, ... }
            // - face_match: { source_image, target_image, ... }
            const idVerification = data.id_verification || data.kyc || data;
            const liveness = data.liveness || {};
            const faceMatch = data.face_match || {};

            return {
                ...user,
                hasDocuments: true,
                documents: {
                    frontImage: idVerification.full_front_image || idVerification.front_image || null,
                    backImage: idVerification.full_back_image || idVerification.back_image || null,
                    selfieImage: liveness.image || liveness.reference_image || faceMatch.source_image || null,
                    selfieVideoUrl: liveness.video_url || null,
                    portraitImage: idVerification.portrait_image || null,
                    documentNumber: idVerification.document_number || user.dni,
                    documentType: idVerification.document_type || null,
                    fullName: idVerification.full_name || `${idVerification.first_name || ''} ${idVerification.last_name || ''}`.trim() || null,
                    firstName: idVerification.first_name || null,
                    lastName: idVerification.last_name || null,
                    dateOfBirth: idVerification.date_of_birth || null,
                    age: idVerification.age || null,
                    gender: idVerification.gender || null,
                    nationality: idVerification.nationality || null,
                    expirationDate: idVerification.expiration_date || null,
                    issuingState: idVerification.issuing_state || idVerification.issuing_country || null,
                    address: idVerification.address || null,
                },
            };
        } catch (error: any) {
            this.logger.error(`Error fetching Didit docs for ${userId}`, error?.message || error);
            return { ...user, hasDocuments: false, error: 'Error al consultar Didit' };
        }
    }

    // ─── Criminal Records ─────────────────────────────

    async addCriminalRecord(userId: string, data: {
        fileUrl: string;
        fileName: string;
        fileType: string;
        issueDate: string;
        expiresAt: string;
        notes?: string;
        uploadedBy: string;
    }) {
        const user = await this.prisma.user.findUnique({ where: { id: userId } });
        if (!user) throw new NotFoundException('Usuario no encontrado');

        const record = await this.prisma.criminalRecord.create({
            data: {
                userId,
                fileUrl: data.fileUrl,
                fileName: data.fileName,
                fileType: data.fileType,
                issueDate: new Date(data.issueDate),
                expiresAt: new Date(data.expiresAt),
                notes: data.notes,
                uploadedBy: data.uploadedBy,
            },
        });

        // Log to Telegram
        this.telegramService.sendLog('criminal_record.uploaded', {
            name: user.name || user.firstName || user.email,
            email: user.email,
            expiresAt: new Date(data.expiresAt).toLocaleDateString('es-AR'),
        } as any).catch(() => { /* non-blocking */ });

        return record;
    }

    async getCriminalRecords(userId: string) {
        return this.prisma.criminalRecord.findMany({
            where: { userId },
            orderBy: { createdAt: 'desc' },
        });
    }

    async deleteCriminalRecord(recordId: string) {
        return this.prisma.criminalRecord.delete({ where: { id: recordId } });
    }

    /**
     * Get the most recent valid criminal record for a user
     * Returns: { record, status: 'vigente' | 'por_vencer' | 'vencido' | null }
     */
    async getCurrentCriminalRecord(userId: string) {
        const record = await this.prisma.criminalRecord.findFirst({
            where: { userId },
            orderBy: { createdAt: 'desc' },
        });
        if (!record) return { record: null, status: null };

        const now = new Date();
        const expires = new Date(record.expiresAt);
        const daysUntilExpiry = Math.floor((expires.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

        let status: 'vigente' | 'por_vencer' | 'vencido';
        if (daysUntilExpiry < 0) status = 'vencido';
        else if (daysUntilExpiry <= 30) status = 'por_vencer';
        else status = 'vigente';

        return { record, status, daysUntilExpiry };
    }

    /**
     * Send push notification to a specific user
     */
    async sendPushNotification(userId: string, title: string, body: string) {
        this.logger.log(`Admin sending push to user ${userId}: ${title} — ${body}`);

        // Check user exists and has FCM tokens
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: { id: true, fcmTokens: true, name: true, firstName: true },
        });

        if (!user) {
            this.logger.warn(`User ${userId} not found`);
            return { success: false, message: 'Usuario no encontrado' };
        }

        const hasTokens = user.fcmTokens && user.fcmTokens.length > 0;
        this.logger.log(`User ${userId} has ${user.fcmTokens?.length || 0} FCM tokens`);

        // Send push (will log if no tokens)
        try {
            await this.usersService.sendPushToUser(userId, title, body, { type: 'admin-message' });
        } catch (error) {
            this.logger.error(`Push send error for ${userId}:`, error);
        }

        // Also emit via WebSocket for instant in-app feedback
        this.matchingGateway.emitToUser(userId, 'notification', {
            title,
            body,
            type: 'admin-message',
        });

        return {
            success: true,
            message: hasTokens
                ? `Push + WebSocket enviados a ${user.name || user.firstName || userId}`
                : `Solo WebSocket enviado (usuario sin token push)`,
            hasPushToken: hasTokens,
            tokenCount: user.fcmTokens?.length || 0,
        };
    }
}
