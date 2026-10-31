// Super-admin auth helper used by admin-only endpoints.
//
// A request is treated as super-admin if ANY of:
//   • `x-admin-secret: $ADMIN_SECRET` header - curl / scripts
//   • Authenticated session whose user.email matches the allowlist AND
//     whose email is verified (an unverified signup with an operator's
//     address is just a regular user)
//   • Authenticated session whose users.user_type = 'super_admin' in the DB
//
// The email allowlist comes solely from the SUPER_ADMIN_EMAIL env var
// (comma/semicolon/space-separated, lowercased). No address is hardcoded -
// set SUPER_ADMIN_EMAIL in the environment (e.g. Vercel) to grant admin
// auto-promotion. An unset var means no email-based super-admins (the DB
// user_type path and x-admin-secret still work).
//
// The DB-column path is the most robust: it survives env-var drift and
// stale-function-instance scenarios. The /api/auth/me endpoint auto-
// promotes any user whose email matches the allowlist to user_type =
// 'super_admin' on first login, so the operator never has to set this
// manually.
import { createHash, timingSafeEqual } from 'node:crypto';
import { requireUser, readSession } from './auth.js';
import { sql } from './db.js';

// Constant-time secret compare. Hash both sides to a fixed 32 bytes first so
// timingSafeEqual gets equal-length buffers and the comparison never leaks
// length or content via early-exit timing.
function secretsMatch(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || !expected) return false;
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export function superAdminEmails() {
  return new Set(
    (process.env.SUPER_ADMIN_EMAIL || '')
      .split(/[,;\s]+/).map((s) => s.toLowerCase().trim()).filter(Boolean),
  );
}

export function emailIsSuperAdmin(email) {
  if (!email) return false;
  return superAdminEmails().has(String(email).toLowerCase().trim());
}

// Promote a user to user_type='super_admin' if their email matches the
// allowlist. Idempotent. Called from /api/auth/me so the operator never
// has to remember to flip a column by hand. Best-effort: if the UPDATE
// fails (schema not migrated, etc.) we silently skip - the email-match
// path will still work.
//
// The account's email must be VERIFIED first. Anyone can sign up with an
// allowlisted address they do not own; until the confirmation link is
// clicked that account is an ordinary user and is never promoted.
export async function ensureSuperAdminPromotion(user) {
  if (!user || !emailIsSuperAdmin(user.email)) return;
  if (user.user_type === 'super_admin') return;
  if (!(await emailVerified(user))) return;
  try {
    await sql`UPDATE users SET user_type = 'super_admin' WHERE id = ${user.id} AND user_type IS DISTINCT FROM 'super_admin' AND email_verified_at IS NOT NULL AND deleted_at IS NULL`;
    user.user_type = 'super_admin';
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[admin] super-admin promotion failed (non-blocking):', e.message);
  }
}

// True when the users row has email_verified_at set. Uses the loaded
// column when the caller already has it (requireUser does), otherwise
// fetches it. Fails closed on any error.
async function emailVerified(user) {
  if (!user?.id) return false;
  if ('email_verified_at' in user) return !!user.email_verified_at;
  try {
    const { rows } = await sql`SELECT email_verified_at FROM users WHERE id = ${user.id}`;
    return !!rows[0]?.email_verified_at;
  } catch { return false; }
}

// Returns true if the caller should be allowed. Sends 401/403 + returns
// false otherwise. `req.method` not GET? For POST endpoints
// `requireSameOrigin` is the caller's responsibility - this helper
// only auths.
export async function requireSuperAdmin(req, res) {
  // Path 1: admin secret header (constant-time compare)
  const secret = process.env.ADMIN_SECRET;
  if (secret && secretsMatch(req.headers['x-admin-secret'], secret)) return true;

  // Path 2 & 3: authenticated user - check both email allowlist AND
  // the DB user_type column. Either path grants access.
  const user = await requireUser(req, res);
  if (!user) return false;
  if (emailIsSuperAdmin(user.email) && (await emailVerified(user))) {
    // Make sure the DB column is set too, so subsequent requests can
    // skip the email-allowlist lookup entirely.
    ensureSuperAdminPromotion(user).catch(() => {});
    return true;
  }
  if (user.user_type === 'super_admin') return true;

  // Diagnostic goes to SERVER LOGS only - never the response body, and
  // never the allowlist or the probing user's address (a log leak would
  // otherwise disclose operator emails). The user id is enough to
  // investigate.
  // eslint-disable-next-line no-console
  console.warn('[admin] super-admin check failed for user', user.id, '- user_type =', user.user_type);
  res.status(403).json({ error: 'Super-admin only' });
  return false;
}

// Lightweight non-throwing variant for cron endpoints which already check
// secret + cron headers and just need a third allowed path. Returns true
// if the request has a valid session belonging to a super-admin.
// Does NOT respond on failure - caller decides what to do.
export async function isSuperAdminBySession(req) {
  const session = readSession(req);
  if (!session?.sub) return false;
  try {
    const { rows } = await sql`
      SELECT email, user_type, email_verified_at, deleted_at, password_changed_at
        FROM users WHERE id = ${session.sub}`;
    const r = rows[0];
    if (!r) return false;
    // Same revocation rules as requireUser: a deleted account has no
    // session, and a JWT issued before the last password change is dead.
    if (r.deleted_at) return false;
    const pcAt = r.password_changed_at;
    if (pcAt && session.iat && (session.iat * 1000) < new Date(pcAt).getTime()) return false;
    if (r.user_type === 'super_admin') return true;
    return emailIsSuperAdmin(r.email) && !!r.email_verified_at;
  } catch { return false; }
}

// Returns the calling user (for audit logging) when the request carries
// a real session. Header-secret callers have no user - returns null and
// the audit row records a system-level action.
export async function getAdminActor(req) {
  const session = readSession(req);
  if (!session?.sub) return null;
  const { rows } = await sql`SELECT id, email, name FROM users WHERE id = ${session.sub}`;
  return rows[0] || null;
}
