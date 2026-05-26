// Auth + session helpers.
// JWT stored in an httpOnly cookie; API routes call requireUser(req, res) to gate.

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import cookie from 'cookie';
import { sql } from './db.js';

const COOKIE = 'thryve_session';
// Stashed admin session while impersonating. Restored by the
// /api/admin/impersonate/stop endpoint. HttpOnly so the impersonated UI
// can't read it.
const IMPERSONATION_BACKUP = 'thryve_admin_session';
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days

function secret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET not set');
  return s;
}

export async function hashPassword(pw) {
  return bcrypt.hash(pw, 10);
}

export async function verifyPassword(pw, hash) {
  return bcrypt.compare(pw, hash);
}

export function signSession(userId, extraClaims = {}) {
  return jwt.sign({ sub: userId, ...extraClaims }, secret(), { expiresIn: `${MAX_AGE}s`, algorithm: 'HS256' });
}

// Vercel runs all deployments over HTTPS, so secure: always-on. NODE_ENV check
// would silently disable secure for any custom environment that doesn't set it.
const COOKIE_BASE = {
  httpOnly: true,    // Not readable by JavaScript — XSS can't exfil the session.
  secure: true,      // Only sent over HTTPS.
  sameSite: 'lax',   // Blocks cross-site POST/PATCH/DELETE under default rules.
  path: '/',
};

// Helper that lets us set multiple cookies in one response. Vercel's
// res.setHeader('Set-Cookie', ...) overwrites — pass an array for stacking.
function setCookies(res, ...cookies) {
  res.setHeader('Set-Cookie', cookies);
}

export function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', cookie.serialize(COOKIE, token, {
    ...COOKIE_BASE,
    maxAge: MAX_AGE,
  }));
}

export function clearSessionCookie(res) {
  // Clear the session AND any impersonation backup, so logging out while
  // impersonating doesn't leave a stale admin backup cookie behind.
  setCookies(res,
    cookie.serialize(COOKIE, '', { ...COOKIE_BASE, maxAge: 0 }),
    cookie.serialize(IMPERSONATION_BACKUP, '', { ...COOKIE_BASE, maxAge: 0 }),
  );
}

// Stash the current session under a backup cookie + set a new one for
// the impersonated user. Both written in a single Set-Cookie array.
export function setImpersonationCookies(res, { backupToken, targetToken }) {
  setCookies(res,
    cookie.serialize(IMPERSONATION_BACKUP, backupToken, {
      ...COOKIE_BASE, maxAge: MAX_AGE,
    }),
    cookie.serialize(COOKIE, targetToken, {
      ...COOKIE_BASE, maxAge: MAX_AGE,
    }),
  );
}

// Restore from backup. Returns the backup token (so the caller can
// verify it before believing it). If no backup exists, returns null
// and the caller should treat the request as a no-op.
export function readImpersonationBackup(req) {
  const header = req.headers.cookie || '';
  const parsed = cookie.parse(header);
  return parsed[IMPERSONATION_BACKUP] || null;
}

export function restoreFromImpersonation(res, originalToken) {
  setCookies(res,
    cookie.serialize(IMPERSONATION_BACKUP, '', { ...COOKIE_BASE, maxAge: 0 }),
    cookie.serialize(COOKIE, originalToken, { ...COOKIE_BASE, maxAge: MAX_AGE }),
  );
}

export function readSession(req) {
  const header = req.headers.cookie || '';
  const parsed = cookie.parse(header);
  const token = parsed[COOKIE];
  if (!token) return null;
  try {
    return jwt.verify(token, secret(), { algorithms: ['HS256'] });
  } catch {
    return null;
  }
}

// Returns the current user row, or sends 401 and returns null.
export async function requireUser(req, res) {
  // Lazy import to avoid a circular dep — auth.js is imported very early.
  const { ensureSchemaApplied } = await import('./ensureSchema.js');
  await ensureSchemaApplied();

  const session = readSession(req);
  if (!session?.sub) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  const { rows } = await sql`
    SELECT id, email, name, created_at, email_verified_at,
           walkthrough_completed_at, user_type,
           terms_accepted_at, terms_version,
           password_changed_at, deleted_at
    FROM users WHERE id = ${session.sub}
  `;
  if (rows.length === 0) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  // Soft-deleted accounts can't sign in. The row hangs around for the
  // 30-day recovery window (db-prune hard-deletes after) so the data
  // isn't immediately gone, but the session is dead the moment the
  // owner clicks Delete. Different status code from password-change
  // so the frontend can show a more accurate message if needed.
  if (rows[0].deleted_at) {
    res.status(401).json({ error: 'Account has been deleted' });
    return null;
  }
  // Stateless JWT revocation: a JWT issued before the user's
  // password_changed_at stamp is invalid. Lets reset-password.js
  // force-logout every existing session for that user without a
  // server-side session table. session.iat is in SECONDS since epoch
  // (jsonwebtoken default); password_changed_at is a timestamp.
  const pcAt = rows[0].password_changed_at;
  if (pcAt && session.iat && (session.iat * 1000) < new Date(pcAt).getTime()) {
    res.status(401).json({ error: 'Session expired — please sign in again' });
    return null;
  }
  return rows[0];
}

// Ensures a workspace exists for this user; returns its id.
//
// Race-safe: two concurrent first-load requests for the same brand-new
// user (signup + first dashboard hit, or two browser tabs at once)
// both pass the SELECT and race to INSERT. Without protection the
// loser raises a unique-key error and the request 500s. We backstop
// with a partial unique index on (owner_id) WHERE row_count=1 — but
// that's expensive to maintain, so instead we just catch the
// duplicate and re-read. Cheap, correct, no schema change.
export async function ensureWorkspace(userId) {
  const existing = await sql`SELECT id FROM workspaces WHERE owner_id = ${userId} LIMIT 1`;
  if (existing.rows.length > 0) return existing.rows[0].id;
  try {
    const created = await sql`
      INSERT INTO workspaces (owner_id) VALUES (${userId}) RETURNING id
    `;
    return created.rows[0].id;
  } catch (err) {
    // Concurrent request won the INSERT — re-read and return its row.
    const retry = await sql`SELECT id FROM workspaces WHERE owner_id = ${userId} LIMIT 1`;
    if (retry.rows.length > 0) return retry.rows[0].id;
    throw err;
  }
}

export function validEmail(e) {
  return typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}
