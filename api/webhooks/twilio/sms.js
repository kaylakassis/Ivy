// POST /api/webhooks/twilio/sms — inbound SMS from Twilio.
//
// THE single inbound webhook to configure in Twilio ("A message comes in").
// It does BOTH jobs that used to be split across two endpoints (so you no
// longer have to choose between reply-threading and STOP compliance):
//   1. Compliance keywords (STOP/UNSUBSCRIBE/… and START/YES/UNSTOP) flip
//      the sender's SMS consent across every workspace that has them.
//   2. Any other text is routed by the sender's phone (last 10 digits) into
//      that client's message thread + notifies the owner.
//
// Configure THRYVE_TWILIO_AUTH_TOKEN so we can verify the signature.
import crypto from 'node:crypto';
import { sql } from '../../_lib/db.js';
import { readRawBody } from '../../_lib/body.js';
import { verifyTwilioSignature } from '../../_lib/twilio.js';
import { normalizePhone } from '../../_lib/sms.js';
import { notifyOwnerSafe } from '../../_lib/push.js';
import { appUrl } from '../../_lib/tokens.js';

export const config = { api: { bodyParser: false } };

// Exact-keyword consent words (Twilio matches the same way). A reply like
// "STOP doing that" is NOT an opt-out — only a bare keyword counts.
const STOP_WORDS  = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']);
const START_WORDS = new Set(['START', 'YES', 'UNSTOP']);

function twiml(res, body = '') {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/xml');
  res.end(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.statusCode = 405; return res.end('Method Not Allowed'); }
  try {
    const raw = await readRawBody(req);
    const params = Object.fromEntries(new URLSearchParams(raw));

    // Verify the request really came from Twilio (HMAC over URL + params).
    const url = `${appUrl()}/api/webhooks/twilio/sms`;
    if (!verifyTwilioSignature({ url, params, signature: req.headers['x-twilio-signature'] })) {
      res.statusCode = 403;
      return res.end('Invalid signature');
    }

    const from = params.From || '';
    const text = (params.Body || '').toString().slice(0, 4000);
    const normalized = normalizePhone(from) || from;
    const last10 = (normalized.match(/\d/g) || []).join('').slice(-10);
    if (!last10 || last10.length < 10) return twiml(res); // can't route — ack + drop

    // ── Compliance keywords first (STOP / START) ──────────────────────
    // Flip SMS consent for EVERY client row matching this number across
    // every workspace (one number = one platform-level consent state).
    // Twilio auto-replies to STOP/START, so we just record + ack.
    const keyword = (params.Body || '').trim().toUpperCase();
    if (STOP_WORDS.has(keyword)) {
      await sql`UPDATE clients SET sms_consent_at = NULL
                 WHERE right(regexp_replace(phone, '\\D', '', 'g'), 10) = ${last10}`;
      return twiml(res);
    }
    if (START_WORDS.has(keyword)) {
      await sql`UPDATE clients SET sms_consent_at = NOW()
                 WHERE right(regexp_replace(phone, '\\D', '', 'g'), 10) = ${last10}`;
      return twiml(res);
    }
    if (keyword === 'HELP' || keyword === 'INFO') {
      return twiml(res); // no state change — carrier/Twilio sends the HELP reply
    }

    // Find the matching client + their most recently active thread.
    const { rows } = await sql`
      SELECT c.id AS client_id, c.workspace_id, t.id AS thread_id
        FROM clients c
        LEFT JOIN message_threads t ON t.client_id = c.id AND t.workspace_id = c.workspace_id
       WHERE c.phone IS NOT NULL
         AND right(regexp_replace(c.phone, '\\D', '', 'g'), 10) = ${last10}
       ORDER BY t.last_message_at DESC NULLS LAST
       LIMIT 1
    `;
    const match = rows[0];
    if (!match) return twiml(res); // unknown sender — ack so Twilio doesn't retry

    // Ensure a thread exists.
    let threadId = match.thread_id;
    if (!threadId) {
      const tIns = await sql`
        INSERT INTO message_threads (workspace_id, client_id)
        VALUES (${match.workspace_id}, ${match.client_id})
        ON CONFLICT (workspace_id, client_id) DO UPDATE SET workspace_id = EXCLUDED.workspace_id
        RETURNING id
      `;
      threadId = tIns.rows[0].id;
    }

    await sql`
      INSERT INTO messages (thread_id, sender, text, meta)
      VALUES (${threadId}, 'client', ${text}, ${JSON.stringify({ channel: 'sms' })}::jsonb)
    `;
    const preview = (text || 'SMS').slice(0, 200);
    await sql`
      UPDATE message_threads SET
        last_message_at = NOW(), last_message_preview = ${preview}, unread_biz = unread_biz + 1
      WHERE id = ${threadId}
    `;

    await notifyOwnerSafe({
      workspaceId: match.workspace_id, type: 'messages',
      payload: { title: 'New text message', body: preview, url: `/messages?threadId=${threadId}`, tag: `thread-${threadId}` },
    });

    return twiml(res);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[twilio/sms] inbound failed:', err.message);
    return twiml(res); // never 500 to Twilio — avoids retry storms
  }
}
