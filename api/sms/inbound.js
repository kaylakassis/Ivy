// POST /api/sms/inbound — Twilio webhook for inbound SMS.
//
// SUPERSEDED: point Twilio at /api/webhooks/twilio/sms instead — that one
// handles these same compliance keywords AND threads non-keyword replies
// into the client conversation. This endpoint remains as a consent-only
// fallback (it does NOT thread replies) for any number still configured here.
//
// Handles the compliance keywords (STOP, UNSUBSCRIBE, CANCEL, END, QUIT,
// START, UNSTOP, YES, HELP) and reflects them across our clients table:
//
//   STOP / UNSUBSCRIBE / CANCEL / END / QUIT  → sms_consent_at = NULL
//                                              for every client matching
//                                              the From number across
//                                              every workspace
//   START / UNSTOP / YES                      → sms_consent_at = NOW()
//   HELP                                      → no state change; Twilio's
//                                              auto-reply or our HELP
//                                              auto-response handles it
//
// Twilio expects an HTTP 200 (or 204) with optional TwiML body. We return
// 204 — Twilio's built-in STOP/START handling already responds to the
// sender on our behalf.
//
// Signature verification: the request URL + sorted form params are
// HMAC-SHA1 signed with our auth_token. We reject any request whose
// X-Twilio-Signature doesn't match. bodyParser is disabled so we have
// access to the raw form encoding for both signature verification AND
// parameter parsing.
import { sql } from '../_lib/db.js';
import { readRawBody } from '../_lib/body.js';
import { verifyTwilioSignature, isTwilioConfigured } from '../_lib/twilio.js';
import { normalizePhone } from '../_lib/sms.js';
import { appUrl } from '../_lib/tokens.js';
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';

export const config = { api: { bodyParser: false } };

const STOP_WORDS  = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']);
const START_WORDS = new Set(['START', 'YES', 'UNSTOP']);

function parseForm(raw) {
  const out = {};
  for (const part of String(raw || '').split('&')) {
    if (!part) continue;
    const i = part.indexOf('=');
    const k = decodeURIComponent((i >= 0 ? part.slice(0, i) : part).replace(/\+/g, ' '));
    const v = decodeURIComponent((i >= 0 ? part.slice(i + 1) : '').replace(/\+/g, ' '));
    out[k] = v;
  }
  return out;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try {
    if (!isTwilioConfigured()) {
      return res.status(500).json({ error: 'Twilio not configured' });
    }

    const raw = await readRawBody(req);
    const params = parseForm(raw);

    // Reconstruct the URL Twilio signed: scheme + host + path. Twilio
    // computes the signature over the public-facing URL it called, so we
    // mirror what they hit using the request headers.
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host  = req.headers.host || new URL(appUrl()).host;
    const url   = `${proto}://${host}${req.url || '/api/sms/inbound'}`;

    const signature = req.headers['x-twilio-signature'];
    if (!verifyTwilioSignature({ url, params, signature })) {
      return res.status(403).json({ error: 'Bad Twilio signature' });
    }

    const from = normalizePhone(params.From);
    const body = (params.Body || '').trim().toUpperCase();
    if (!from) return ok(res, { ok: true, ignored: 'no From' });

    if (STOP_WORDS.has(body)) {
      // Wipe consent for EVERY client row matching this number, across
      // every workspace this number is associated with. Compliance > UX
      // here — one number = one consent state at the platform layer.
      await sql`UPDATE clients SET sms_consent_at = NULL WHERE phone = ${from}`;
      return ok(res, { ok: true, action: 'opt-out', phone: from });
    }
    if (START_WORDS.has(body)) {
      await sql`UPDATE clients SET sms_consent_at = NOW() WHERE phone = ${from}`;
      return ok(res, { ok: true, action: 'opt-in', phone: from });
    }
    // Anything else (HELP, freeform, etc.) — ack with no state change.
    return ok(res, { ok: true, ignored: body || '(empty)' });
  } catch (err) {
    return serverError(res, err);
  }
}
