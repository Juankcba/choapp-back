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
export const TERMS_VERSION = '2026-04-18';
