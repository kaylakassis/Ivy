// Auth + session helpers.
// JWT stored in an httpOnly cookie; API routes call requireUser(req, res) to gate.

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import cookie from 'cookie';
import { sql } from './db.js';
import { getOrSet as hotCacheGetOrSet, invalidate as hotCacheInvalidate } from './hotCache.js';

const COOKIE = 'ivy_session';
// Stashed admin session while impersonating. Restored by the
// /api/admin/impersonate/stop endpoint. HttpOnly so the impersonated UI
// can't read it.
const IMPERSONATION_BACKUP = 'ivy_admin_session';
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
  httpOnly: true,    // Not readable by JavaScript - XSS can't exfil the session.
  secure: true,      // Only sent over HTTPS.
  sameSite: 'lax',   // Blocks cross-site POST/PATCH/DELETE under default rules.
  path: '/',
};

// Helper that lets us set multiple cookies in one response. Vercel's
// res.setHeader('Set-Cookie', ...) overwrites - pass an array for stacking.
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

// Source the bearer token from `Authorization: Bearer <jwt>` first, then
// fall back to the HttpOnly session cookie. Native iOS (Capacitor) uses
// the header path because its cross-origin XHR drops SameSite=Lax cookies;
// the web continues to use cookies and never sends Authorization.
function readToken(req) {
  const auth = req.headers.authorization || req.headers.Authorization;
  if (auth && /^Bearer\s+/i.test(auth)) {
    const t = auth.replace(/^Bearer\s+/i, '').trim();
    if (t) return t;
  }
  const header = req.headers.cookie || '';
  const parsed = cookie.parse(header);
  return parsed[COOKIE] || null;
}

export function readSession(req) {
  const token = readToken(req);
  if (!token) return null;
  try {
    return jwt.verify(token, secret(), { algorithms: ['HS256'] });
  } catch {
    return null;
  }
}

// True when the request was made by the native iOS/Android Capacitor
// shell, which sets X-Client-Platform on every fetch. Used by login /
// signup / OAuth-callback endpoints to also include the raw JWT in the
// response body so the client can stash it in iOS Keychain - the cookie
// they'd otherwise rely on doesn't cross the WebView↔API origin gap.
export function isNativeClient(req) {
  const v = req.headers['x-client-platform'] || req.headers['X-Client-Platform'];
  return v === 'ios' || v === 'android';
}

// User-row cache for the auth hot path. requireUser fires on EVERY
// authenticated request — at 100K active users that's millions of
// identical indexed SELECTs/day. A short TTL collapses them while a
// warm function instance lives (~minutes on Vercel).
//
// SECURITY: the cached row carries password_changed_at + deleted_at,
// the two fields that revoke sessions. A naive cache would let a
// reset-password'd or deleted session live for the TTL. We defend two
// ways: (1) the TTL is SHORT (15s) so the worst-case lag is small, and
// (2) every security-critical write — password reset, logout-all,
// account delete/restore — calls invalidateUserCache(userId) so the
// revocation is immediate in practice and the TTL is only a backstop
// for a missed invalidate. The revocation CHECK itself still runs on
// every request against the cached password_changed_at, so even within
// the TTL a session whose iat predates a (cached) password change is
// rejected — the only staleness window is the gap between a password
// change landing in the DB and the cache entry expiring/invalidating.
const USER_ROW_TTL_MS = 15_000;

export function invalidateUserCache(userId) {
  if (userId) hotCacheInvalidate(`user:${userId}`);
}

// Returns the current user row, or sends 401 and returns null.
export async function requireUser(req, res) {
  // Lazy import to avoid a circular dep - auth.js is imported very early.
  const { ensureSchemaApplied } = await import('./ensureSchema.js');
  await ensureSchemaApplied();

  const session = readSession(req);
  if (!session?.sub) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  const row = await hotCacheGetOrSet(`user:${session.sub}`, USER_ROW_TTL_MS, async () => {
    const { rows } = await sql`
      SELECT id, email, name, created_at, email_verified_at,
             walkthrough_completed_at, user_type,
             terms_accepted_at, terms_version,
             privacy_version, privacy_accepted_at,
             password_changed_at, deleted_at
      FROM users WHERE id = ${session.sub}
    `;
    // Cache `null` for a genuinely-absent user so a bogus/old session
    // doesn't re-hit the DB every request; getOrSet caches null but not
    // undefined, and an absent row is a stable fact for the TTL.
    return rows[0] || null;
  });
  if (!row) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  // Soft-deleted accounts can't sign in. The row hangs around for the
  // 30-day recovery window (db-prune hard-deletes after) so the data
  // isn't immediately gone, but the session is dead the moment the
  // owner clicks Delete. account/delete.js calls invalidateUserCache so
  // this check sees the deletion within ≤15s even on a warm instance.
  if (row.deleted_at) {
    res.status(401).json({ error: 'Account has been deleted' });
    return null;
  }
  // Stateless JWT revocation: a JWT issued before the user's
  // password_changed_at stamp is invalid. Lets reset-password.js
  // force-logout every existing session for that user without a
  // server-side session table. session.iat is in SECONDS since epoch
  // (jsonwebtoken default); password_changed_at is a timestamp.
  const pcAt = row.password_changed_at;
  if (pcAt && session.iat && (session.iat * 1000) < new Date(pcAt).getTime()) {
    res.status(401).json({ error: 'Session expired - please sign in again' });
    return null;
  }
  return row;
}

// Ensures a workspace exists for this user; returns its id.
//
// Race-safe: two concurrent first-load requests for the same brand-new
// user (signup + first dashboard hit, or two browser tabs at once)
// both pass the SELECT and race to INSERT. Without protection the
// loser raises a unique-key error and the request 500s. We backstop
// with a partial unique index on (owner_id) WHERE row_count=1 - but
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
    // Concurrent request won the INSERT - re-read and return its row.
    const retry = await sql`SELECT id FROM workspaces WHERE owner_id = ${userId} LIMIT 1`;
    if (retry.rows.length > 0) return retry.rows[0].id;
    throw err;
  }
}

export function validEmail(e) {
  return typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}
