// Frontend mirror of api/_lib/legal.js. Bumping the version means
// updating both files together - tests in /api will reject signups
// pinned to a stale version, so a mismatch will surface immediately.
export const CURRENT_TERMS_VERSION = '2026-05-05';

// Privacy Policy gets the same separate-from-terms versioning so a
// material change to data-handling practices can re-prompt acceptance
// independently of any terms change.
export const CURRENT_PRIVACY_VERSION = '2026-05-25';
