// A light "are you a person" check for the sign-up form, with no third
// party and nothing for a real person to solve:
//   1. a hidden field people never see or fill (scripts that fill every
//      field give themselves away), and
//   2. a signed token the page fetches when it opens; a sign-up arriving
//      less than two seconds after the page opened was not typed by hand.
// It stops form-filling scripts. It does not stop a person sitting at a
// keyboard, which is what the confirmed-email rule and Admin > Risk are for.
//
// Older iPhone app builds (1.0.6 and earlier) do not send the token. They
// are let through on the app's own origin marker, the same one
// requireSameOrigin trusts, so those builds keep working.
import { createHmac, timingSafeEqual } from 'node:crypto';

const MIN_AGE_MS = 2000;
const MAX_AGE_MS = 2 * 60 * 60 * 1000;
export const HONEYPOT_FIELD = 'ivy_contact_note';
export const HUMAN_CHECK_MESSAGE = 'That did not go through. Please refresh the page and try again.';
export const HUMAN_CHECK_FAST_MESSAGE = 'That was quick. Please try again.';

const secret = () => process.env.JWT_SECRET || '';
const sign = (ts) => createHmac('sha256', secret()).update(`signup-form:${ts}`).digest('hex').slice(0, 32);

// null when no signing secret is configured (the check then passes).
export function issueFormToken(now = Date.now()) {
  if (!secret()) return null;
  return `${now}.${sign(now)}`;
}

function isNativeApp(req) {
  const platform = String(req.headers?.['x-client-platform'] || '').toLowerCase();
  if (platform !== 'ios' && platform !== 'android') return false;
  const host = (v) => { try { return new URL(String(v)).hostname; } catch { return ''; } };
  return host(req.headers?.origin) === 'localhost' || host(req.headers?.referer) === 'localhost';
}

// { ok: true } or { ok: false, code, message }.
export function checkHuman(req, body, now = Date.now()) {
  if (body && typeof body[HONEYPOT_FIELD] === 'string' && body[HONEYPOT_FIELD].trim() !== '') {
    return { ok: false, code: 'human_check', message: HUMAN_CHECK_MESSAGE };
  }
  // Switched off only by the test bootstrap (never set in production).
  if (!secret() || process.env.SIGNUP_HUMAN_CHECK === 'off') return { ok: true };
  const token = body && typeof body.formToken === 'string' ? body.formToken : '';
  if (!token) {
    return isNativeApp(req) ? { ok: true } : { ok: false, code: 'human_check', message: HUMAN_CHECK_MESSAGE };
  }
  const [tsRaw, mac] = token.split('.');
  const ts = Number(tsRaw);
  const want = Number.isFinite(ts) ? sign(ts) : '';
  const good = !!mac && mac.length === want.length && timingSafeEqual(Buffer.from(mac), Buffer.from(want));
  if (!good) return { ok: false, code: 'human_check', message: HUMAN_CHECK_MESSAGE };
  const age = now - ts;
  if (age < MIN_AGE_MS) return { ok: false, code: 'human_check_fast', message: HUMAN_CHECK_FAST_MESSAGE };
  if (age > MAX_AGE_MS) return { ok: false, code: 'human_check', message: HUMAN_CHECK_MESSAGE };
  return { ok: true };
}
