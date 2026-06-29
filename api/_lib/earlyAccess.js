// Temporary "early access" password gate. When enabled, blocks
// /api/auth/signup and /api/auth/login until the visitor supplies the
// correct password through /api/early-access/verify, which sets an
// HMAC-signed cookie keyed to the current password hash.
//
// Removal plan: flip the toggle off in /admin (instant), or for full
// code removal, delete this file + the two early-access endpoints +
// the EarlyAccessGate component + the four call sites in signup.js,
// login.js, forgot-password.js, and resend-verification.js.
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { sql } from './db.js';

const COOKIE_NAME = 'ea_pass';
// Same-site Lax so the cookie travels on top-level navigations (signin
// link clicked from email) but not on cross-site POSTs.
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

// One-shot loader. The settings row is created by the schema migration,
// so this should always return a row in normal operation; we tolerate
// missing for the pre-migration first request.
export async function getGateSettings() {
  try {
    const { rows } = await sql`
      SELECT early_access_enabled, early_access_password_hash, early_access_updated_at
        FROM app_settings WHERE id = 1
    `;
    const r = rows[0] || {};
    return {
      enabled:     !!r.early_access_enabled,
      hasPassword: !!r.early_access_password_hash,
      passwordHash: r.early_access_password_hash || null,
      updatedAt:   r.early_access_updated_at || null,
    };
  } catch {
    // Table doesn't exist yet (pre-migration) → gate is implicitly off.
    return { enabled: false, hasPassword: false, passwordHash: null, updatedAt: null };
  }
}

// Controlled-launch mode (orthogonal to the password gate). Returns
// 'open' or 'waitlist'. Fails open to 'open' if the column/table doesn't
// exist yet (pre-migration first request) so a cold start never traps
// signups in waitlist mode by accident.
export async function getLaunchMode() {
  try {
    const { rows } = await sql`SELECT launch_mode FROM app_settings WHERE id = 1`;
    const mode = rows[0]?.launch_mode;
    return mode === 'waitlist' ? 'waitlist' : 'open';
  } catch {
    return 'open';
  }
}

// Admin: flip the launch switch. Only 'open' | 'waitlist' are valid.
export async function setLaunchMode(mode) {
  const next = mode === 'waitlist' ? 'waitlist' : 'open';
  await sql`
    UPDATE app_settings
       SET launch_mode = ${next},
           launch_mode_updated_at = NOW()
     WHERE id = 1
  `;
  return next;
}

// Beta-tester bypass for waitlist mode. The early-access password
// (early_access_password_hash) doubles as the bypass key: a select user
// who enters it on the waitlist screen gets the same ea_pass cookie and
// can sign up normally (onboarding + everything downstream untouched).
//
// Unlike isGateUnlocked(), this is INDEPENDENT of early_access_enabled:
// in waitlist mode the standalone early-access gate is usually off, but
// the password still needs to act as a bypass. Returns true only when a
// password is configured AND the request carries a cookie matching it.
export async function hasBypassCookie(req) {
  const settings = await getGateSettings();
  if (!settings.passwordHash) return false; // no bypass password set -> nobody bypasses
  const cookieVal = parseCookie(req, COOKIE_NAME);
  if (!cookieVal) return false;
  const expected = signCookieValue(settings.passwordHash);
  if (cookieVal.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(cookieVal, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

// Validate a beta-bypass password attempt and, on success, return the
// cookie value the waitlist verify endpoint should set. Independent of
// early_access_enabled (see hasBypassCookie) - the configured password
// is the bypass key whether or not the standalone gate is toggled on.
export async function attemptBypass(plaintext) {
  const settings = await getGateSettings();
  if (!settings.passwordHash) return { ok: false, reason: 'no_password_set' };
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    return { ok: false, reason: 'empty' };
  }
  const matched = await bcrypt.compare(plaintext, settings.passwordHash);
  if (!matched) return { ok: false, reason: 'bad_password' };
  return { ok: true, cookieValue: signCookieValue(settings.passwordHash) };
}

// Cookie value is the HMAC of the current password hash. Rotating the
// password invalidates every previously-issued cookie automatically.
function signCookieValue(passwordHash) {
  const secret = process.env.JWT_SECRET || '';
  return crypto.createHmac('sha256', secret).update('ea:' + passwordHash).digest('hex');
}

function parseCookie(req, name) {
  const raw = req.headers?.cookie || '';
  for (const part of raw.split(/;\s*/)) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq) === name) {
      return decodeURIComponent(part.slice(eq + 1));
    }
  }
  return null;
}

// Returns true if the gate is currently OFF, or if it's ON and the
// request carries a cookie that matches the current password hash.
export async function isGateUnlocked(req) {
  const settings = await getGateSettings();
  if (!settings.enabled) return true;
  if (!settings.passwordHash) return true; // misconfig — fail open rather than lock out
  const cookieVal = parseCookie(req, COOKIE_NAME);
  if (!cookieVal) return false;
  const expected = signCookieValue(settings.passwordHash);
  // Length-equality first to avoid timingSafeEqual throwing on mismatched length.
  if (cookieVal.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(cookieVal, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

// Verify a plaintext password attempt against the stored hash and, on
// success, return the cookie value the verify endpoint should set.
export async function attemptUnlock(plaintext) {
  const settings = await getGateSettings();
  if (!settings.enabled) return { ok: true, cookieValue: null, reason: 'gate_off' };
  if (!settings.passwordHash) return { ok: false, reason: 'no_password_set' };
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    return { ok: false, reason: 'empty' };
  }
  const matched = await bcrypt.compare(plaintext, settings.passwordHash);
  if (!matched) return { ok: false, reason: 'bad_password' };
  return { ok: true, cookieValue: signCookieValue(settings.passwordHash) };
}

// Admin: replace the gate password. Pass empty/null to clear it (which
// also forces enabled=false — a missing password with the gate on
// would lock out the whole world, so we refuse that combo).
export async function setGatePassword(plaintext) {
  if (!plaintext) {
    await sql`
      UPDATE app_settings
         SET early_access_password_hash = NULL,
             early_access_enabled = FALSE,
             early_access_updated_at = NOW()
       WHERE id = 1
    `;
    return;
  }
  const hash = await bcrypt.hash(String(plaintext), 10);
  await sql`
    UPDATE app_settings
       SET early_access_password_hash = ${hash},
           early_access_updated_at    = NOW()
     WHERE id = 1
  `;
}

// Admin: flip the toggle. If turning ON without a password set, refuse.
export async function setGateEnabled(enabled) {
  const settings = await getGateSettings();
  if (enabled && !settings.hasPassword) {
    const err = new Error('Set a password before enabling the gate');
    err.code = 'no_password';
    throw err;
  }
  await sql`
    UPDATE app_settings
       SET early_access_enabled    = ${!!enabled},
           early_access_updated_at = NOW()
     WHERE id = 1
  `;
}

// Express-style helper for auth endpoints. Writes a 403 + JSON body
// and returns false when the gate blocks the request; returns true
// when the caller may proceed.
export async function requireGate(req, res) {
  const unlocked = await isGateUnlocked(req);
  if (unlocked) return true;
  res.statusCode = 403;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({
    error: 'Early access required',
    code:  'early_access_required',
  }));
  return false;
}

// Cookie writer used by /api/early-access/verify. Caller passes the
// cookieValue from attemptUnlock(). HttpOnly so the value can't be
// read from JS — the gate is a server-side check anyway.
export function setGateCookie(res, value) {
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; SameSite=Lax; Secure`,
  );
}

// Used when the password rotates or the gate is disabled — clear the
// cookie so visitors aren't carrying stale credentials.
export function clearGateCookie(res) {
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure`,
  );
}
