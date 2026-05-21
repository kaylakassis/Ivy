// POST /api/webhooks/twilio/sms — inbound SMS from Twilio.
//
// THRYVE uses a single platform Twilio number, so we route an incoming
// text by the SENDER's phone: match it to a client (by the last 10
// digits) and append the message to that client's thread. If the same
// phone is a client of multiple businesses, we attach it to the most
// recently active conversation (the one they're most likely replying to).
//
// Owners point their Twilio number's "A message comes in" webhook here.
// Configure THRYVE_TWILIO_AUTH_TOKEN so we can verify the signature.
import crypto from 'node:crypto';
import { sql } from '../../_lib/db.js';
import { readRawBody } from '../../_lib/body.js';
import { verifyTwilioSignature } from '../../_lib/twilio.js';
import { normalizePhone } from '../../_lib/sms.js';
import { notifyOwnerSafe } from '../../_lib/push.js';
import { appUrl } from '../../_lib/tokens.js';

export const config = { api: { bodyParser: false } };

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
      payload: { title: 'New text message', body: preview, url: `/messages?thread=${threadId}`, tag: `thread-${threadId}` },
    });

    return twiml(res);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[twilio/sms] inbound failed:', err.message);
    return twiml(res); // never 500 to Twilio — avoids retry storms
  }
}
