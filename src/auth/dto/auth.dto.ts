import {
    IsEmail,
    IsString,
    MinLength,
    IsEnum,
    IsOptional,
    IsNumber,
    IsArray,
    IsNotEmpty,
    ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

class LocationDto {
    @IsNumber()
    lat: number;

    @IsNumber()
    lng: number;
}

class EmergencyContactDto {
    @IsString()
    name: string;

    @IsString()
    phone: string;

    @IsString()
    relationship: string;
}

export class RegisterDto {
    @IsEmail()
    email: string;

    @MinLength(6)
    password: string;

    @IsString()
    phone: string;

    @IsString()
    @MinLength(2)
    firstName: string;

    @IsString()
    @MinLength(2)
    lastName: string;

    @IsEnum(['family', 'caregiver'])
    role: 'family' | 'caregiver';

    // Consent to Terms & Privacy at sign-up. Required: the client must send
    // the TERMS_VERSION it is agreeing to, so the stored consent is pinned
    // to an exact legal text.
    @IsString()
    @IsNotEmpty()
    termsAcceptedVersion: string;

    // Family specific
    @IsOptional()
    @IsString()
    address?: string;

    @IsOptional()
    @ValidateNested()
    @Type(() => LocationDto)
    location?: LocationDto;

    @IsOptional()
    @ValidateNested()
    @Type(() => EmergencyContactDto)
    emergencyContact?: EmergencyContactDto;

    // Caregiver specific
    @IsOptional()
    @IsString()
    bio?: string;

    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    specialties?: string[];

    @IsOptional()
    @IsNumber()
    experience?: number;

    @IsOptional()
    @IsNumber()
    hourlyRate?: number;
}

export class LoginDto {
    @IsEmail()
    email: string;

    @MinLength(6)
    password: string;
}
