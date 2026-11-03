// 2-step verification by email: one-time 6-digit codes sent to the
// account's verified address, plus the shared "password OK, now ask for a
// code" step used by login, password reset and account restore.
//
// Codes:
//   - crypto.randomInt, 6 digits, stored only as an HMAC keyed by the server
//     secret AND bound to the user + purpose, so a code (or its hash) from one
//     account can never satisfy another.
//   - live 10 minutes; 5 wrong tries burn the code; a new code burns the old.
//   - at most 5 codes per user per hour, one per 30 seconds, and 20 per IP per
//     hour (rate_limits table, same limiter as the rest of the API).
//   - sent with the raw sendEmail: a security email, no unsubscribe link, not
//     subject to notification preferences or the workspace email quota.
import crypto from 'node:crypto';
import { sql } from './db.js';
import { signMfaToken, setMfaCookie, isNativeClient } from './auth.js';
import { rateLimit, getClientIp } from './rate-limit.js';
import { sendEmail } from './email.js';
import { renderMfaCodeEmail, prettyDevice, fmtWhen } from './securityNotify.js';
import { reportError } from './monitoring.js';

export const MFA_EMAIL_CODE_TTL_MINUTES = 10;
export const MFA_EMAIL_MAX_ATTEMPTS = 5;
export const MFA_EMAIL_MAX_PER_HOUR = 5;
export const MFA_EMAIL_COOLDOWN_SECONDS = 30;
export const MFA_EMAIL_IP_MAX_PER_HOUR = 20;

function hmacSecret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET not set');
  return s;
}

export function hashEmailCode(userId, purpose, code) {
  return crypto.createHmac('sha256', hmacSecret())
    .update(`mfa-email:${userId}:${purpose}:${String(code)}`)
    .digest('hex');
}

function safeEqualHex(a, b) {
  const x = Buffer.from(String(a || ''), 'hex');
  const y = Buffer.from(String(b || ''), 'hex');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

// "kayla@example.com" -> "k***a@example.com". Shown on the code screen so the
// person knows which inbox to check, without echoing the full address.
export function maskEmail(email) {
  const e = String(email || '');
  const at = e.lastIndexOf('@');
  if (at <= 0) return '';
  const local = e.slice(0, at);
  const domain = e.slice(at);
  if (local.length <= 2) return `${local[0]}***${domain}`;
  return `${local[0]}***${local[local.length - 1]}${domain}`;
}

// Sends a fresh code. Returns { ok: true, email } or
// { ok: false, status, error, retryAfterSeconds? }. Never throws.
export async function sendEmailCode({ userId, purpose = 'login', req }) {
  try {
    const { rows } = await sql`
      SELECT id, email, name, email_verified_at, deleted_at FROM users WHERE id = ${userId}
    `;
    const u = rows[0];
    if (!u || !u.email) return { ok: false, status: 400, error: 'This account has no email address.' };
    if (!u.email_verified_at) {
      return { ok: false, status: 400, error: 'Confirm your email address first, then try again.' };
    }

    // 30-second cooldown between codes for the same purpose (so signing in
    // right after finishing setup still gets its code).
    const last = await sql`
      SELECT created_at FROM mfa_email_codes
       WHERE user_id = ${userId} AND purpose = ${purpose}
         AND created_at > NOW() - make_interval(secs => ${MFA_EMAIL_COOLDOWN_SECONDS})
       ORDER BY created_at DESC LIMIT 1
    `;
    if (last.rows[0]) {
      const age = (Date.now() - new Date(last.rows[0].created_at).getTime()) / 1000;
      const wait = Math.max(1, Math.ceil(MFA_EMAIL_COOLDOWN_SECONDS - age));
      return { ok: false, status: 429, retryAfterSeconds: wait, error: `Please wait ${wait} seconds before asking for another code.` };
    }

    // Hourly cap per user (counted from the codes themselves) and per IP.
    const hour = await sql`
      SELECT COUNT(*)::int AS n FROM mfa_email_codes
       WHERE user_id = ${userId} AND created_at > NOW() - INTERVAL '1 hour'
    `;
    if ((hour.rows[0]?.n || 0) >= MFA_EMAIL_MAX_PER_HOUR) {
      return { ok: false, status: 429, retryAfterSeconds: 3600, error: 'Too many codes sent in the last hour. Use a backup code, or try again later.' };
    }
    const ip = req ? getClientIp(req) : 'unknown';
    const ipLimit = await rateLimit({ key: `mfa:email:send:ip:${ip}`, max: MFA_EMAIL_IP_MAX_PER_HOUR, windowSeconds: 3600 });
    if (!ipLimit.allowed) {
      return { ok: false, status: 429, retryAfterSeconds: ipLimit.retryAfterSeconds, error: 'Too many codes requested from this network. Try again later.' };
    }

    // A new code replaces any earlier one for the same purpose.
    await sql`
      UPDATE mfa_email_codes SET consumed_at = NOW()
       WHERE user_id = ${userId} AND purpose = ${purpose} AND consumed_at IS NULL
    `;
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const ins = await sql`
      INSERT INTO mfa_email_codes (user_id, purpose, code_hash, expires_at)
      VALUES (${userId}, ${purpose}, ${hashEmailCode(userId, purpose, code)},
              NOW() + make_interval(mins => ${MFA_EMAIL_CODE_TTL_MINUTES}))
      RETURNING id
    `;

    const rendered = renderMfaCodeEmail({
      firstName: (u.name || '').split(/\s+/)[0],
      code, purpose,
      device: prettyDevice(req?.headers?.['user-agent']),
      ip: req ? ip : null,
      when: fmtWhen(),
    });
    try {
      await sendEmail({ to: u.email, subject: rendered.subject, html: rendered.html, timeoutMs: 8000 });
    } catch (err) {
      // Didn't go out: drop the row so it neither counts toward the caps nor
      // sits there as a live code nobody received.
      await sql`DELETE FROM mfa_email_codes WHERE id = ${ins.rows[0].id}`.catch(() => {});
      reportError(err, { extra: { userId, where: 'mfaEmail.send' } });
      return { ok: false, status: 502, error: "We couldn't send the email just now. Try again in a moment, or use a backup code." };
    }
    return { ok: true, email: maskEmail(u.email) };
  } catch (err) {
    reportError(err, { extra: { userId, where: 'mfaEmail.sendEmailCode' } });
    return { ok: false, status: 500, error: 'Something went wrong sending your code.' };
  }
}

// Checks a 6-digit email code. Returns { ok: true } or
// { ok: false, reason: 'none' | 'expired' | 'wrong' | 'burned' }.
// Only the newest live code for this user + purpose is considered.
export async function verifyEmailCode({ userId, purpose = 'login', code }) {
  const c = String(code || '').trim();
  if (!/^\d{6}$/.test(c)) return { ok: false, reason: 'wrong' };
  // The newest code decides: a fresh send consumes the older ones, so a
  // consumed newest row means it was used, burned or cancelled.
  const { rows } = await sql`
    SELECT id, code_hash, attempts, expires_at, consumed_at
      FROM mfa_email_codes
     WHERE user_id = ${userId} AND purpose = ${purpose}
     ORDER BY created_at DESC LIMIT 1
  `;
  const row = rows[0];
  if (!row) return { ok: false, reason: 'none' };
  if (row.consumed_at) {
    return { ok: false, reason: row.attempts >= MFA_EMAIL_MAX_ATTEMPTS ? 'burned' : 'none' };
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await sql`UPDATE mfa_email_codes SET consumed_at = NOW() WHERE id = ${row.id} AND consumed_at IS NULL`;
    return { ok: false, reason: 'expired' };
  }
  if (row.attempts >= MFA_EMAIL_MAX_ATTEMPTS) {
    await sql`UPDATE mfa_email_codes SET consumed_at = NOW() WHERE id = ${row.id} AND consumed_at IS NULL`;
    return { ok: false, reason: 'burned' };
  }
  if (safeEqualHex(row.code_hash, hashEmailCode(userId, purpose, c))) {
    // Single use: only the request that flips consumed_at wins.
    const won = await sql`
      UPDATE mfa_email_codes SET consumed_at = NOW()
       WHERE id = ${row.id} AND consumed_at IS NULL AND attempts < ${MFA_EMAIL_MAX_ATTEMPTS}
       RETURNING id
    `;
    return won.rows[0] ? { ok: true } : { ok: false, reason: 'burned' };
  }
  const bumped = await sql`
    UPDATE mfa_email_codes SET attempts = attempts + 1,
           consumed_at = CASE WHEN attempts + 1 >= ${MFA_EMAIL_MAX_ATTEMPTS} THEN NOW() ELSE consumed_at END
     WHERE id = ${row.id}
     RETURNING attempts
  `;
  const n = bumped.rows[0]?.attempts || MFA_EMAIL_MAX_ATTEMPTS;
  return { ok: false, reason: n >= MFA_EMAIL_MAX_ATTEMPTS ? 'burned' : 'wrong', attemptsLeft: Math.max(0, MFA_EMAIL_MAX_ATTEMPTS - n) };
}

// Plain-language message for a failed email code.
export function emailCodeError(reason) {
  if (reason === 'expired') return 'That code has expired. Send a new code and try again.';
  if (reason === 'burned') return 'Too many wrong tries for that code. Send a new code and try again.';
  if (reason === 'none') return "That code didn't match. Send a new code, or use a backup code.";
  return "That code didn't match. Try again, or use a backup code.";
}

export function mfaMethodsFor(user) {
  const methods = [];
  if (user?.totp_enrolled_at) methods.push('totp');
  if (user?.mfa_email_enabled_at) methods.push('email');
  return methods;
}

export function hasTwoStep(user) {
  return !!(user?.totp_enrolled_at || user?.mfa_email_enabled_at);
}

// The shared "password (or inbox) proved, now the second factor" step.
// Issues the 5-minute MFA-pending token (httpOnly cookie on web, in the body
// for the iPhone app) and, for an email-only account, sends the first code.
// Returns the fields to merge into the response body.
export async function beginMfaStep(req, res, user) {
  const mfaToken = signMfaToken(user.id);
  setMfaCookie(res, mfaToken);
  const methods = mfaMethodsFor(user);
  const out = { mfaRequired: true, mfaMethods: methods };
  if (methods[0] === 'email') {
    // Email is the only method: send the code now so it is waiting.
    const sent = await sendEmailCode({ userId: user.id, purpose: 'login', req });
    out.mfaEmailSent = !!sent.ok;
    if (sent.ok) out.mfaEmail = sent.email;
    else {
      out.mfaEmailError = sent.error;
      if (sent.retryAfterSeconds) out.mfaRetryAfterSeconds = sent.retryAfterSeconds;
    }
  }
  if (isNativeClient(req)) out.mfaToken = mfaToken; // native can't use the cookie
  return out;
}
