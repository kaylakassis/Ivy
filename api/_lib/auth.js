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

// Known placeholder values shipped in .env.example. Sessions signed
// with these are forgeable by anyone who can read the template, so
// boot-time rejection here protects against the "operator copied the
// example and didn't replace the secret" failure mode.
const PLACEHOLDER_SECRETS = new Set([
  'change-me-to-a-long-random-string',
  'changeme',
  'CHANGE_ME',
  'replace-me',
]);

function secret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET not set');
  // Reject obvious placeholders + suspiciously short keys. 32 chars is
  // a low floor (Stripe / Twilio secrets are 32+); the bcrypt-equivalent
  // SHA-256 needs at least this for security parity. Real fix is for
  // the operator to set a properly random value.
  if (PLACEHOLDER_SECRETS.has(s) || s.length < 32) {
    throw new Error('JWT_SECRET is too weak — must be at least 32 random characters and not a placeholder');
  }
  return s;
}

export async function hashPassword(pw) {
  return bcrypt.hash(pw, 10);
}

export async function verifyPassword(pw, hash) {
  return bcrypt.compare(pw, hash);
}

export function signSession(userId, extraClaims = {}) {
  return jwt.sign({ sub: userId, ...extraClaims }, secret(), { expiresIn: `${MAX_AGE}s` });
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
  res.setHeader('Set-Cookie', cookie.serialize(COOKIE, '', {
    ...COOKIE_BASE,
    maxAge: 0,
  }));
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
    return jwt.verify(token, secret());
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
           terms_accepted_at, terms_version
    FROM users WHERE id = ${session.sub}
  `;
  if (rows.length === 0) {
    res.status(401).json({ error: 'Unauthorized' });
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
