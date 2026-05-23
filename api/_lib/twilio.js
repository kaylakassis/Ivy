// Tiny Twilio REST client. We only use one endpoint (POST a message),
// so the official SDK isn't worth the bundle weight.
//
// Env:
//   THRYVE_TWILIO_ACCOUNT_SID  AC…
//   THRYVE_TWILIO_AUTH_TOKEN   <token>
//   THRYVE_TWILIO_FROM_NUMBER  +15551234567   (Twilio-verified)

import { fetchWithTimeout } from './fetchTimeout.js';

const TWILIO_BASE = 'https://api.twilio.com/2010-04-01';

export function isTwilioConfigured() {
  return !!(process.env.THRYVE_TWILIO_ACCOUNT_SID
    && process.env.THRYVE_TWILIO_AUTH_TOKEN
    && process.env.THRYVE_TWILIO_FROM_NUMBER);
}

// POST /Accounts/{SID}/Messages.json. Returns the Twilio response (sid,
// status, etc.) on success. Throws on non-2xx with the Twilio error
// message attached for log surfacing.
export async function sendSms({ to, body }) {
  const sid    = process.env.THRYVE_TWILIO_ACCOUNT_SID;
  const token  = process.env.THRYVE_TWILIO_AUTH_TOKEN;
  const from   = process.env.THRYVE_TWILIO_FROM_NUMBER;
  if (!sid || !token || !from) {
    throw new Error('Twilio not configured');
  }
  if (!to || !body) throw new Error('to + body are required');

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
import crypto from 'node:crypto';

export function verifyTwilioSignature({ url, params, signature }) {
  const token = process.env.THRYVE_TWILIO_AUTH_TOKEN;
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
