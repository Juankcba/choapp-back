// Catálogo cerrado de especialidades que un cuidador puede declarar y por el
// que una familia puede buscar. Mongo no enforza enums; la validación corre en
// los DTOs y en el matching service.
//
// Los labels en español son solo para UI/emails — el valor canónico es el key
// en inglés/snake_case.
//
// IMPORTANTE: agregar nuevas especialidades requiere revisar también el copy
// del frontend. No eliminar valores sin migración — servicios existentes los
// siguen usando.

export const SPECIALTIES = [
    'general_care',              // Cuidado general / compañía
    'elderly_care',              // Cuidado de adultos mayores
    'dementia_care',             // Cuidado de personas con demencia / alzheimer
    'special_needs',             // Cuidado de personas con discapacidad
    'postsurgery_care',          // Cuidado postoperatorio
    'medication_management',     // Administración de medicación
    'physical_therapy',          // Kinesiología / terapia física
    'psychology',                // Psicología
    'therapeutic_companion',     // Acompañante terapéutico
    'nutrition',                 // Nutrición
    'speech_therapy',            // Fonoaudiología
    'occupational_therapy',      // Terapia ocupacional
] as const;

export type Specialty = typeof SPECIALTIES[number];

export function isSpecialty(value: unknown): value is Specialty {
    return typeof value === 'string' && (SPECIALTIES as readonly string[]).includes(value);
}

// Especialidades que típicamente se prestan de forma remota. Útil para el UI
// (mostrar primero en el selector cuando el familiar elige modalidad virtual)
// y como hint al matching, pero NO bloquea: una familia puede pedir kinesiología
// virtual si así lo pacta con el profesional.
export const VIRTUAL_FRIENDLY_SPECIALTIES: readonly Specialty[] = [
    'psychology',
    'therapeutic_companion',
    'nutrition',
    'speech_therapy',
];
