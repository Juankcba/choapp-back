/**
 * Argentinian provinces with approximate bounding boxes.
 * Used for filtering caregivers by province via lat/lng bbox check.
 * bbox: [minLat, minLng, maxLat, maxLng]
 */

export interface Province {
    slug: string;
    name: string;
    bbox: [number, number, number, number];
    /** Approximate center for map focusing */
    center: [number, number];
    /** Zoom level to focus this province */
    zoom: number;
}

export const AR_PROVINCES: Province[] = [
    { slug: 'caba', name: 'Ciudad Autónoma de Buenos Aires', bbox: [-34.71, -58.54, -34.52, -58.33], center: [-34.61, -58.44], zoom: 11 },
    { slug: 'buenos-aires', name: 'Buenos Aires', bbox: [-41.05, -63.40, -33.26, -56.66], center: [-36.7, -60.0], zoom: 6 },
    { slug: 'catamarca', name: 'Catamarca', bbox: [-30.10, -69.05, -25.21, -64.95], center: [-27.5, -66.9], zoom: 7 },
    { slug: 'chaco', name: 'Chaco', bbox: [-28.00, -63.43, -24.10, -58.37], center: [-26.3, -60.8], zoom: 7 },
    { slug: 'chubut', name: 'Chubut', bbox: [-46.00, -71.90, -41.99, -63.60], center: [-44.0, -68.5], zoom: 6 },
    { slug: 'cordoba', name: 'Córdoba', bbox: [-35.00, -65.80, -29.55, -61.80], center: [-32.2, -63.8], zoom: 7 },
    { slug: 'corrientes', name: 'Corrientes', bbox: [-30.77, -59.67, -27.30, -55.65], center: [-28.8, -57.9], zoom: 7 },
    { slug: 'entre-rios', name: 'Entre Ríos', bbox: [-33.85, -60.75, -30.15, -57.80], center: [-32.0, -59.2], zoom: 7 },
    { slug: 'formosa', name: 'Formosa', bbox: [-26.90, -62.35, -22.35, -57.52], center: [-24.7, -59.8], zoom: 7 },
    { slug: 'jujuy', name: 'Jujuy', bbox: [-24.50, -67.50, -21.78, -64.10], center: [-23.2, -65.8], zoom: 7 },
    { slug: 'la-pampa', name: 'La Pampa', bbox: [-39.40, -68.30, -35.00, -63.37], center: [-37.1, -65.8], zoom: 7 },
    { slug: 'la-rioja', name: 'La Rioja', bbox: [-31.95, -69.65, -27.75, -65.95], center: [-29.8, -67.8], zoom: 7 },
    { slug: 'mendoza', name: 'Mendoza', bbox: [-37.60, -70.60, -31.95, -66.45], center: [-34.7, -68.5], zoom: 7 },
    { slug: 'misiones', name: 'Misiones', bbox: [-28.18, -56.05, -25.48, -53.62], center: [-26.9, -54.7], zoom: 7 },
    { slug: 'neuquen', name: 'Neuquén', bbox: [-41.05, -71.92, -36.67, -68.00], center: [-38.9, -69.9], zoom: 7 },
    { slug: 'rio-negro', name: 'Río Negro', bbox: [-42.00, -71.92, -37.60, -62.85], center: [-40.0, -67.4], zoom: 7 },
    { slug: 'salta', name: 'Salta', bbox: [-26.40, -68.60, -21.77, -62.35], center: [-24.2, -65.4], zoom: 7 },
    { slug: 'san-juan', name: 'San Juan', bbox: [-32.45, -70.58, -28.33, -66.75], center: [-30.4, -68.8], zoom: 7 },
    { slug: 'san-luis', name: 'San Luis', bbox: [-36.00, -67.20, -32.00, -64.90], center: [-34.0, -66.0], zoom: 7 },
    { slug: 'santa-cruz', name: 'Santa Cruz', bbox: [-52.36, -73.58, -45.85, -65.50], center: [-49.0, -70.0], zoom: 6 },
    { slug: 'santa-fe', name: 'Santa Fe', bbox: [-34.00, -62.85, -28.00, -58.85], center: [-31.0, -60.7], zoom: 7 },
    { slug: 'santiago-del-estero', name: 'Santiago del Estero', bbox: [-30.70, -65.55, -25.63, -61.65], center: [-28.2, -63.5], zoom: 7 },
    { slug: 'tierra-del-fuego', name: 'Tierra del Fuego', bbox: [-55.10, -68.65, -52.60, -63.80], center: [-54.0, -66.5], zoom: 7 },
    { slug: 'tucuman', name: 'Tucumán', bbox: [-28.00, -66.20, -26.00, -64.50], center: [-27.0, -65.3], zoom: 8 },
];

const BY_SLUG = new Map(AR_PROVINCES.map((p) => [p.slug, p]));

export function findProvince(slug: string | null | undefined): Province | undefined {
    if (!slug) return undefined;
    return BY_SLUG.get(slug.toLowerCase());
}

export function isInProvince(lat: number, lng: number, province: Province): boolean {
    const [minLat, minLng, maxLat, maxLng] = province.bbox;
    return lat >= minLat && lat <= maxLat && lng >= minLng && lng <= maxLng;
}
