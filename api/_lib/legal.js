// Versioned legal documents. Bump the version string when you
// substantively change the Terms or Privacy text - every existing user
// will be force-prompted to re-accept on their next request.
//
// Format: ISO-date string. Easier to scan than a semver. Pair this with
// the matching content edits in src/features/legal/TermsPage.jsx and
// PrivacyPage.jsx; the on-disk version constant in those files is just
// for display, this constant is the source of truth.
//
// IMPORTANT: have a real attorney review the actual policy text before
// charging anyone. The text here is best-effort template language, not
// legal advice.
export const CURRENT_TERMS_VERSION = '2026-05-05';

// Same versioning contract for the Privacy Policy - when you
// substantively change /privacy text, bump this string + the mirror
// in src/lib/legal.js, and every existing user will be re-prompted
// to re-accept on their next request. legal_acceptances stores both
// (document='terms', document='privacy') so the audit trail can show
// exactly which version of each they saw.
export const CURRENT_PRIVACY_VERSION = '2026-10-31';

// Earlier Privacy Policy versions still accepted AT SIGN-UP. The iPhone
// app ships its own copy of the policy and its version number, so a build
// already in the App Store keeps sending the version it shows until people
// update. We record exactly the version the person accepted, and anyone on
// an older version sees the in-app "We updated our Privacy Policy" notice
// (api/auth/me.js privacy.needsAcknowledgement). Drop an entry once the
// app builds that ship it are no longer in use.
export const PRIOR_PRIVACY_VERSIONS = ['2026-05-25'];

// The version to record for a sign-up, or null when it is not one we accept.
export function acceptablePrivacyVersion(v) {
  const s = String(v || '');
  if (s === CURRENT_PRIVACY_VERSION || PRIOR_PRIVACY_VERSIONS.includes(s)) return s;
  return null;
}

// Returns true if the user has accepted the current Terms version.
// Acceptance is denormalized onto users.terms_version for cheap lookups
// - the legal_acceptances table holds the full audit trail with IP+UA.
export function hasAcceptedCurrentTerms(user) {
  if (!user) return false;
  return user.terms_version === CURRENT_TERMS_VERSION;
}

// Same check for the Privacy Policy. Denormalized onto
// users.privacy_version so /api/auth/me can return acceptance state
// alongside terms without an extra round trip.
export function hasAcceptedCurrentPrivacy(user) {
  if (!user) return false;
  return user.privacy_version === CURRENT_PRIVACY_VERSION;
}
