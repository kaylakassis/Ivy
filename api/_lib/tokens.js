// Auth tokens for email verification + password reset.
// We hand the user a raw token (in a URL); we store only its sha256 hash.
// On redemption we hash the submitted token and look it up.
import crypto from 'node:crypto';
import { sql } from './db.js';

const KIND_VERIFY = 'verify_email';
const KIND_RESET  = 'reset_password';
export { KIND_VERIFY, KIND_RESET };

export function generateRawToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export async function createToken({ userId, kind, ttlMinutes }) {
  if (![KIND_VERIFY, KIND_RESET].includes(kind)) throw new Error(`Invalid token kind: ${kind}`);
  const raw = generateRawToken();
  const tokenHash = hashToken(raw);
  const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();

  await sql`
    INSERT INTO auth_tokens (user_id, kind, token_hash, expires_at)
    VALUES (${userId}, ${kind}, ${tokenHash}, ${expiresAt})
  `;
  return raw;
}

// Looks up a token, returns the user_id if valid + unused + unexpired, else null.
// Caller is responsible for marking it used (consumeToken).
export async function findValidToken({ kind, raw }) {
  if (typeof raw !== 'string' || raw.length < 16) return null;
  const tokenHash = hashToken(raw);
  const { rows } = await sql`
    SELECT id, user_id, expires_at, used_at
    FROM auth_tokens
    WHERE kind = ${kind} AND token_hash = ${tokenHash}
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  const t = rows[0];
  if (t.used_at) return null;
  if (new Date(t.expires_at).getTime() < Date.now()) return null;
  return { tokenId: t.id, userId: t.user_id };
}

export async function consumeToken(tokenId) {
  await sql`UPDATE auth_tokens SET used_at = NOW() WHERE id = ${tokenId} AND used_at IS NULL`;
}

// Invalidate all live tokens of a kind for a user (e.g. after password reset succeeds).
export async function invalidateUserTokens({ userId, kind }) {
  await sql`
    UPDATE auth_tokens SET used_at = NOW()
    WHERE user_id = ${userId} AND kind = ${kind} AND used_at IS NULL
  `;
}

// Public app URL — used when constructing verification / reset links.
// Vercel sets VERCEL_URL to the deploy URL; we prefer an explicit APP_URL when set.
export function appUrl() {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, '');
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return 'http://localhost:5173';
}
