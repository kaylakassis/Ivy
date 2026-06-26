// Tiny Twilio REST client. We only use one endpoint (POST a message),
// so the official SDK isn't worth the bundle weight.
//
// Env:
//   IVY_TWILIO_ACCOUNT_SID  AC…
//   IVY_TWILIO_AUTH_TOKEN   <token>
//   IVY_TWILIO_FROM_NUMBER  +15551234567                — single number (legacy)
//   IVY_TWILIO_FROM_NUMBERS +15551234567,+15559876543   — comma-separated pool (preferred at scale)
//
// Why a pool: a single long-code number is rate-limited to 1 message/sec
// (Twilio + the carriers). At 1M users sending booking reminders +
// workflow SMS, one number caps you at ~86K messages/day. Adding more
// numbers in Twilio and listing them here multiplies that ceiling
// linearly with no code change. The pool picker hashes by recipient
// phone so the same recipient always sees messages from the same
// number — important because carriers treat a recipient flipping
// numbers as a spam signal.

import { fetchWithTimeout } from './fetchTimeout.js';
import crypto from 'node:crypto';

const TWILIO_BASE = 'https://api.twilio.com/2010-04-01';

// Returns the array of From-numbers available to send from. NUMBERS
// (plural) takes precedence over NUMBER (singular). Empty array means
// "not configured" — the caller already guards with isTwilioConfigured.
function fromPool() {
  const plural = (process.env.IVY_TWILIO_FROM_NUMBERS || '').trim();
  if (plural) {
    return plural.split(',').map((n) => n.trim()).filter(Boolean);
  }
  const single = (process.env.IVY_TWILIO_FROM_NUMBER || '').trim();
  return single ? [single] : [];
}

export function isTwilioConfigured() {
  return !!(process.env.IVY_TWILIO_ACCOUNT_SID
    && process.env.IVY_TWILIO_AUTH_TOKEN
    && fromPool().length > 0);
}

// Pick a stable From-number for a given recipient. Hashing on `to`
// keeps each recipient pinned to one number across runs — flipping
// senders is a spam signal that carriers (T-Mobile in particular)
// penalize. Falls back to the single-number env when only one is
// configured; deterministic regardless of pool size.
function pickFromNumber(to) {
  const pool = fromPool();
  if (pool.length === 0) throw new Error('Twilio not configured');
  if (pool.length === 1) return pool[0];
  const hash = crypto.createHash('sha256').update(String(to || '')).digest();
  const idx = hash.readUInt32BE(0) % pool.length;
  return pool[idx];
}

// POST /Accounts/{SID}/Messages.json. Returns the Twilio response (sid,
// status, etc.) on success. Throws on non-2xx with the Twilio error
// message attached for log surfacing.
export async function sendSms({ to, body }) {
  const sid    = process.env.IVY_TWILIO_ACCOUNT_SID;
  const token  = process.env.IVY_TWILIO_AUTH_TOKEN;
  if (!sid || !token) {
    throw new Error('Twilio not configured');
  }
  if (!to || !body) throw new Error('to + body are required');
  const from = pickFromNumber(to);

  const auth = Buffer.from(`${sid}:${token}`).toString('base64');
  const form = new URLSearchParams({ From: from, To: to, Body: body });

  const res = await fetchWithTimeout(`${TWILIO_BASE}/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: form.toString(),
  }, 8000);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.message || `Twilio ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.twilioCode = json?.code;
    throw err;
  }
  return { sid: json.sid, status: json.status };
}

// Verifies a Twilio request signature so the inbound webhook can trust
// the payload (STOP / HELP keywords) actually came from Twilio. See
// https://www.twilio.com/docs/usage/webhooks/webhooks-security
//
// Twilio signs HTTPS_URL + sorted_form_params(concatenated) with
// HMAC-SHA1 keyed on auth_token, base64.
export function verifyTwilioSignature({ url, params, signature }) {
  const token = process.env.IVY_TWILIO_AUTH_TOKEN;
  if (!token || !signature) return false;
  const sortedKeys = Object.keys(params || {}).sort();
  let data = url;
  for (const k of sortedKeys) data += k + (params[k] ?? '');
  const expected = crypto.createHmac('sha1', token).update(data).digest('base64');
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(signature),
    );
  } catch {
    return false;
  }
}
