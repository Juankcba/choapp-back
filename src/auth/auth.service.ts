import {
    Injectable,
    ConflictException,
    UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as bcrypt from 'bcryptjs';
import { User, UserDocument } from '../schemas/user.schema';
import { Caregiver, CaregiverDocument } from '../schemas/caregiver.schema';
import { Family, FamilyDocument } from '../schemas/family.schema';
import { RegisterDto, LoginDto } from './dto/auth.dto';

@Injectable()
export class AuthService {
    constructor(
        @InjectModel(User.name) private userModel: Model<UserDocument>,
        @InjectModel(Caregiver.name)
        private caregiverModel: Model<CaregiverDocument>,
        @InjectModel(Family.name) private familyModel: Model<FamilyDocument>,
        private jwtService: JwtService,
    ) { }

    async register(registerDto: RegisterDto) {
        const existingUser = await this.userModel.findOne({
            email: registerDto.email,
        });
        if (existingUser) {
            throw new ConflictException('El usuario ya existe');
        }

        const hashedPassword = await bcrypt.hash(registerDto.password, 10);

        const user = await this.userModel.create({
            email: registerDto.email,
            password: hashedPassword,
            phone: registerDto.phone,
            firstName: registerDto.firstName,
            lastName: registerDto.lastName,
            role: registerDto.role,
        });

        // Create role-specific profile
        if (
            registerDto.role === 'family' &&
            registerDto.address &&
            registerDto.location
        ) {
            await this.familyModel.create({
                userId: user._id,
                address: registerDto.address,
                location: {
                    type: 'Point',
                    coordinates: [registerDto.location.lng, registerDto.location.lat],
                },
                emergencyContact: registerDto.emergencyContact || {
                    name: '',
                    phone: '',
                    relationship: '',
                },
                paymentMethods: [],
                serviceHistory: [],
                favoriteCaregiversIds: [],
            });
        } else if (registerDto.role === 'family') {
            // Create basic family profile to be completed in onboarding
            await this.familyModel.create({
                userId: user._id,
                address: registerDto.address || 'Pendiente',
                location: {
                    type: 'Point',
                    coordinates: [0, 0],
                },
                emergencyContact: { name: 'Pendiente', phone: '0', relationship: 'Pendiente' },
                paymentMethods: [],
                serviceHistory: [],
                favoriteCaregiversIds: [],
            });
        } else if (registerDto.role === 'caregiver') {
            await this.caregiverModel.create({
                userId: user._id,
                bio: registerDto.bio || '',
                specialties: registerDto.specialties || [],
                experience: registerDto.experience || 0,
                hourlyRate: registerDto.hourlyRate || 0,
                certifications: [],
                documents: [],
                rating: 0,
                totalReviews: 0,
                totalServices: 0,
                availability: { isAvailable: true, schedule: [] },
                serviceRadius: 30000,
                verificationStatus: 'pending',
                earnings: { total: 0, pending: 0, available: 0 },
            });
        }

        const token = this.generateToken(user);

        return {
            message: 'Usuario creado exitosamente',
            user: {
                id: user._id,
                email: user.email,
                role: user.role,
                firstName: user.firstName,
                lastName: user.lastName,
            },
            access_token: token,
        };
    }

    async login(loginDto: LoginDto) {
        const user = await this.userModel.findOne({ email: loginDto.email });
        if (!user) {
            throw new UnauthorizedException('Credenciales inválidas');
        }

        const passwordsMatch = await bcrypt.compare(
            loginDto.password,
            user.password,
        );
        if (!passwordsMatch) {
            throw new UnauthorizedException('Credenciales inválidas');
        }

        // Update last login
        await this.userModel.findByIdAndUpdate(user._id, {
            lastLogin: new Date(),
        });

        const token = this.generateToken(user);

        return {
            user: {
                id: user._id,
                email: user.email,
                role: user.role,
                firstName: user.firstName,
                lastName: user.lastName,
            },
            access_token: token,
        };
    }

    async validateUser(email: string, password: string) {
        const user = await this.userModel.findOne({ email });
        if (!user) return null;

        const passwordsMatch = await bcrypt.compare(password, user.password);
        if (!passwordsMatch) return null;

        return {
            id: user._id.toString(),
            email: user.email,
            name: `${user.firstName} ${user.lastName}`,
            role: user.role,
        };
    }

    private generateToken(user: UserDocument) {
        const payload = {
            sub: user._id.toString(),
            email: user.email,
            role: user.role,
        };
        return this.jwtService.sign(payload);
    }
}
