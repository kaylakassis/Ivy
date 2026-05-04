// Super-admin auth helper used by admin-only endpoints.
//
// An endpoint is reachable by a super-admin if EITHER:
//   • The request carries `x-admin-secret: $ADMIN_SECRET` (curl / scripts), OR
//   • There's an authenticated session whose user.email matches one of the
//     allowlisted super-admin emails (in-app admin panel buttons).
//
// The allowlist is the union of:
//   • DEFAULT_SUPER_ADMINS below (the operator's hardcoded address — keeps
//     the admin panel reachable even before any env vars are set in a
//     fresh deploy)
//   • SUPER_ADMIN_EMAIL env var (comma-separated list, lowercased)
//
// Both auth paths are kept so existing curl playbooks still work.
import { requireUser, readSession } from './auth.js';
import { sql } from './db.js';

const DEFAULT_SUPER_ADMINS = ['kayla@market-theory.com'];

export function superAdminEmails() {
  const fromEnv = (process.env.SUPER_ADMIN_EMAIL || '')
    .split(/[,;\s]+/).map((s) => s.toLowerCase().trim()).filter(Boolean);
  return new Set([...DEFAULT_SUPER_ADMINS, ...fromEnv]);
}

export function emailIsSuperAdmin(email) {
  if (!email) return false;
  return superAdminEmails().has(String(email).toLowerCase().trim());
}

// Returns true if the caller should be allowed. Sends 401 + returns false
// otherwise. `req.method` not GET? For POST endpoints `requireSameOrigin`
// is the caller's responsibility — this helper only auths.
export async function requireSuperAdmin(req, res) {
  // Path 1: admin secret header
  const secret = process.env.ADMIN_SECRET;
  if (secret && req.headers['x-admin-secret'] === secret) return true;

  // Path 2: authenticated user whose email matches SUPER_ADMIN_EMAIL
  // requireUser sends 401 if no session, so we don't double-respond.
  const user = await requireUser(req, res);
  if (!user) return false;
  if (!emailIsSuperAdmin(user.email)) {
    res.status(403).json({ error: 'Super-admin only' });
    return false;
  }
  return true;
}

// Lightweight non-throwing variant for cron endpoints which already check
// secret + cron headers and just need a third allowed path. Returns true
// if the request has a valid session belonging to a super-admin email.
// Does NOT respond on failure — caller decides what to do.
export async function isSuperAdminBySession(req) {
  const session = readSession(req);
  if (!session?.sub) return false;
  const { rows } = await sql`SELECT email FROM users WHERE id = ${session.sub}`;
  return emailIsSuperAdmin(rows[0]?.email);
}
