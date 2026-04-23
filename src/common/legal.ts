/**
 * Version string for the published Terms & Conditions / Privacy Policy.
 *
 * Bump this whenever the legal text changes materially. Any user whose
 * `User.termsAcceptedVersion` is not equal to this constant must re-accept
 * on their next login or action that requires a current consent.
 *
 * Convention: YYYY-MM-DD of the text's effective date, optionally suffixed
 * with a revision letter (2026-04-18, 2026-04-18.b, ...).
 */
// Bump del 2026-04-19: cambio material en el posicionamiento legal — CHO
// pasó a ser plataforma de conexión pura, sin intermediar pagos ni avalar
// la calidad del servicio. La nueva versión exige re-aceptación a todos
// los usuarios para que tengan consentimiento explícito del nuevo marco.
export const TERMS_VERSION = '2026-04-19';
