// Persisted record of webhook deliveries we could not handle, so the
// operator finds out by email (api/cron/ops-alerts.js) instead of from a
// provider's retry dashboard. Two kinds of row:
//   event_type 'signature_verification'  the provider's signature or
//                                         bearer check failed
//   event_type <provider event type>      the handler threw after verifying
//
// Best-effort by design: this must never change what the webhook returns
// to the provider, so every failure here is swallowed.
import { sql } from './db.js';

export const SIGNATURE_FAILURE = 'signature_verification';

export async function recordWebhookFailure(info) {
  try {
    const { source, eventType, message } = info || {};
    await sql`
      INSERT INTO webhook_failures (source, event_type, message)
      VALUES (${String(source || 'unknown').slice(0, 80)},
              ${eventType ? String(eventType).slice(0, 120) : null},
              ${redact(message)})
    `;
  } catch { /* never let bookkeeping fail a webhook */ }
}

function redact(m) {
  return String(m?.message || m || '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/\b(sk|rk|whsec)_[A-Za-z0-9_]+/g, '[key]')
    .slice(0, 500);
}
