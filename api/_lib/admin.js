// Super-admin auth helper used by admin-only endpoints.
//
// A request is treated as super-admin if ANY of:
//   • `x-admin-secret: $ADMIN_SECRET` header - curl / scripts
//   • Authenticated session whose user.email matches the allowlist
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
import { requireUser, readSession } from './auth.js';
import { sql } from './db.js';

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
export async function ensureSuperAdminPromotion(user) {
  if (!user || !emailIsSuperAdmin(user.email)) return;
  if (user.user_type === 'super_admin') return;
  try {
    await sql`UPDATE users SET user_type = 'super_admin' WHERE id = ${user.id} AND user_type IS DISTINCT FROM 'super_admin'`;
    user.user_type = 'super_admin';
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[admin] super-admin promotion failed (non-blocking):', e.message);
  }
}

// Returns true if the caller should be allowed. Sends 401/403 + returns
// false otherwise. `req.method` not GET? For POST endpoints
// `requireSameOrigin` is the caller's responsibility - this helper
// only auths.
export async function requireSuperAdmin(req, res) {
  // Path 1: admin secret header
  const secret = process.env.ADMIN_SECRET;
  if (secret && req.headers['x-admin-secret'] === secret) return true;

  // Path 2 & 3: authenticated user - check both email allowlist AND
  // the DB user_type column. Either path grants access.
  const user = await requireUser(req, res);
  if (!user) return false;
  if (emailIsSuperAdmin(user.email)) {
    // Make sure the DB column is set too, so subsequent requests can
    // skip the email-allowlist lookup entirely.
    ensureSuperAdminPromotion(user).catch(() => {});
    return true;
  }
  if (user.user_type === 'super_admin') return true;

  // Diagnostic goes to SERVER LOGS only - never the response body. The
  // 403 used to echo the full super-admin allowlist + the caller's
  // user_type to any authenticated non-admin who probed an admin route,
  // disclosing operator emails. Keep that detail where only the operator
  // can see it.
  // eslint-disable-next-line no-console
  console.warn('[admin] super-admin check failed for', JSON.stringify(user.email),
    '- user_type =', user.user_type, '- allowed =', Array.from(superAdminEmails()));
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
    const { rows } = await sql`SELECT email, user_type FROM users WHERE id = ${session.sub}`;
    const r = rows[0];
    if (!r) return false;
    return emailIsSuperAdmin(r.email) || r.user_type === 'super_admin';
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
