// Auth + session helpers.
// JWT stored in an httpOnly cookie; API routes call requireUser(req, res) to gate.

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import cookie from 'cookie';
import { sql } from './db.js';

const COOKIE = 'thryve_session';
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

export function signSession(userId) {
  return jwt.sign({ sub: userId }, secret(), { expiresIn: `${MAX_AGE}s` });
}

// Vercel runs all deployments over HTTPS, so secure: always-on. NODE_ENV check
// would silently disable secure for any custom environment that doesn't set it.
const COOKIE_BASE = {
  httpOnly: true,    // Not readable by JavaScript — XSS can't exfil the session.
  secure: true,      // Only sent over HTTPS.
  sameSite: 'lax',   // Blocks cross-site POST/PATCH/DELETE under default rules.
  path: '/',
};

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
    SELECT id, email, name, created_at, email_verified_at
    FROM users WHERE id = ${session.sub}
  `;
  if (rows.length === 0) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  return rows[0];
}

// Ensures a workspace exists for this user; returns its id.
export async function ensureWorkspace(userId) {
  const existing = await sql`SELECT id FROM workspaces WHERE owner_id = ${userId} LIMIT 1`;
  if (existing.rows.length > 0) return existing.rows[0].id;
  const created = await sql`
    INSERT INTO workspaces (owner_id) VALUES (${userId}) RETURNING id
  `;
  return created.rows[0].id;
}

export function validEmail(e) {
  return typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}
