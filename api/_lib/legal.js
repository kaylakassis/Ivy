// Versioned legal documents. Bump the version string when you
// substantively change the Terms or Privacy text — every existing user
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

// Returns true if the user has accepted the current Terms version.
// Acceptance is denormalized onto users.terms_version for cheap lookups
// — the legal_acceptances table holds the full audit trail with IP+UA.
export function hasAcceptedCurrentTerms(user) {
  if (!user) return false;
  return user.terms_version === CURRENT_TERMS_VERSION;
}
