// Webhook event deduplication.
//
// Every payment-provider webhook handler calls `markProcessed(provider,
// eventId, workspaceId)` immediately after signature verification.
// Returns:
//   - true  → first time we've seen this event, proceed
//   - false → already processed, caller should short-circuit with 200
//
// Why insert-first dedup (vs. application-state checks): payment
// providers retry aggressively on any non-2xx response, AND on
// timeout. A handler that 500s mid-write (e.g. notifyOwner threw,
// or Postgres blipped) leaves application state in a half-written
// place — the next delivery sees that state and the application-
// state guard may or may not catch it. This table is the single
// source of truth for "have we seen event X yet?".
//
// Backed by webhook_event_dedup (see schema.js). A nightly retention
// cron trims rows older than 90 days (providers don't retry past
// then — Stripe retries for up to 3 days, Square for ~24h, PayPal
// for ~25 hours).
import { sql } from './db.js';

export async function markProcessed(provider, eventId, workspaceId = null) {
  if (!eventId) {
    // No event ID = legacy or test payload. Don't dedup; let it through.
    return true;
  }
  try {
    const { rows } = await sql`
      INSERT INTO webhook_event_dedup (provider, event_id, workspace_id)
      VALUES (${provider}, ${eventId}, ${workspaceId})
      ON CONFLICT (provider, event_id) DO NOTHING
      RETURNING 1
    `;
    return rows.length > 0;
  } catch (err) {
    // Dedup failure should not stop a real webhook from being
    // processed (worst case: we re-process; the existing app-level
    // idempotency guards still apply). Log + assume first-time.
    // eslint-disable-next-line no-console
    console.error(`[webhookDedup] ${provider}/${eventId} insert failed:`, err.message);
    return true;
  }
}
