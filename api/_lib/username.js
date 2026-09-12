// Usernames: the handle every account signs up with.
//
// Rules (same on the sign-up page, the profile page and here):
//   3 to 24 characters; letters, numbers, periods and underscores; must
//   start and end with a letter or number; no two periods in a row.
//   Stored lowercase, compared lowercase, so "Kayla" and "kayla" are the
//   same handle. A short reserved list keeps impersonation handles out.
import { sql } from './db.js';

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 24;
const SHAPE = /^[a-z0-9](?:[a-z0-9_]|\.(?!\.))*[a-z0-9]$/;
const RESERVED = new Set([
  'admin', 'administrator', 'ivy', 'joinivy', 'support', 'help', 'root', 'api',
  'me', 'system', 'null', 'undefined', 'team', 'staff', 'owner', 'client',
  'clients', 'billing', 'security', 'abuse', 'postmaster', 'webmaster',
  'official', 'moderator', 'mod', 'kayla',
]);

export function normalizeUsername(raw) {
  return String(raw ?? '').trim().replace(/^@/, '').toLowerCase();
}

// Returns { ok: true, value } or { ok: false, error } with a sentence the
// user can act on.
export function validateUsername(raw) {
  const value = normalizeUsername(raw);
  if (!value) return { ok: false, error: 'Pick a username' };
  if (value.length < USERNAME_MIN) return { ok: false, error: `Usernames need at least ${USERNAME_MIN} characters` };
  if (value.length > USERNAME_MAX) return { ok: false, error: `Usernames can be at most ${USERNAME_MAX} characters` };
  if (!SHAPE.test(value)) return { ok: false, error: 'Use letters, numbers, periods and underscores, starting and ending with a letter or number' };
  if (RESERVED.has(value)) return { ok: false, error: 'That username is reserved' };
  return { ok: true, value };
}

// Is this (already normalized) handle held by a live account other than
// excludeUserId? Deleted accounts release their handle.
export async function usernameTaken(value, excludeUserId = null) {
  const { rows } = excludeUserId
    ? await sql`SELECT 1 FROM users WHERE username = ${value} AND deleted_at IS NULL AND id <> ${excludeUserId} LIMIT 1`
    : await sql`SELECT 1 FROM users WHERE username = ${value} AND deleted_at IS NULL LIMIT 1`;
  return rows.length > 0;
}
