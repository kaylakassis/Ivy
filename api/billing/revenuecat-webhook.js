// POST /api/billing/revenuecat-webhook  (public, signed)
//
// Source of truth for iOS in-app subscription state, the same role
// /api/webhooks/billing.js plays for Stripe. RevenueCat is the SDK +
// receipt-validation layer in front of Apple's StoreKit; it consumes
// Apple's App Store Server Notifications V2 and forwards a clean,
// provider-agnostic event to this endpoint.
//
// We're not the receipt validator and we're not parsing Apple's notify
// payload - RevenueCat does both. We just trust their signed event and
// flip the workspace's subscription state.
//
// Auth: shared-secret bearer header (REVENUECAT_WEBHOOK_SECRET). RC lets
// you set an arbitrary Authorization header on every webhook delivery
// (Project Settings → Integrations → Webhooks → Authorization header).
// Constant-time compared; no signature trick because RC doesn't publish
// an HMAC scheme - bearer is what they offer.
//
// Event types we care about (RC docs:
// https://www.revenuecat.com/docs/webhooks/webhooks-overview):
//   INITIAL_PURCHASE       → first paid txn for a customer
//   RENEWAL                → auto-renewed
//   PRODUCT_CHANGE         → upgrade/downgrade (monthly ↔ yearly)
//   CANCELLATION           → user turned auto-renew off (still entitled
//                            until period_end)
//   EXPIRATION             → period_end passed without renewal
//   BILLING_ISSUE          → renewal payment failed
//   UNCANCELLATION         → user re-enabled auto-renew before expiration
//   SUBSCRIBER_ALIAS       → identity merge (ignore - we use stable workspace id)
//
// We mirror these to the same workspaces.subscription_status enum
// Stripe uses, so the rest of the app (paywall, dunning, owner
// notifications) doesn't need to know about Apple at all. The
// 'subscription_source' column distinguishes Apple-billed workspaces
// from Stripe-billed ones for the few code paths that DO care (the
// Cancel button deep-links to Apple Settings instead of Stripe portal;
// renewal price comes from the App Store product instead of Stripe).
import { sql } from '../_lib/db.js';
import { readRawBody } from '../_lib/body.js';
import { markProcessed, releaseProcessed } from '../_lib/webhookDedup.js';
import {
  notifySubscriptionStarted,
  notifyPaymentFailed,
  notifySubscriptionCancelled,
} from '../_lib/subscriptionNotify.js';
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';
import crypto from 'node:crypto';

export const config = { api: { bodyParser: false } };

// Constant-time bearer compare. Falls back to direct string compare if
// the lengths differ - timingSafeEqual throws on length mismatch, and
// we don't want a length-leak from the throw path.
function bearerOk(header, secret) {
  if (!header || !secret) return false;
  const m = /^Bearer\s+(.+)$/i.exec(header);
  const provided = m ? m[1] : header;
  if (provided.length !== secret.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(secret));
}

// Map RC event types to our subscription_status. RC's `type` is on
// event.event.type; the SAME event may carry an expiration timestamp
// (event.event.expiration_at_ms) that determines if the entitlement is
// still active - we honor that for CANCELLATION (user turned off
// auto-renew, but still has the paid period).
function statusForEvent(eventType, expirationMs, nowMs) {
  switch (eventType) {
    case 'INITIAL_PURCHASE':
    case 'RENEWAL':
    case 'PRODUCT_CHANGE':
    case 'UNCANCELLATION':
      return 'active';
    case 'CANCELLATION':
      // Auto-renew is off, but the user paid for the current period and
      // keeps access until expiration. Stay 'active' until EXPIRATION.
      if (expirationMs && expirationMs > nowMs) return 'active';
      return 'cancelled';
    case 'EXPIRATION':
      return 'cancelled';
    case 'BILLING_ISSUE':
      return 'past_due';
    default:
      return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  let claimedEventId = null;
  try {
    const secret = process.env.REVENUECAT_WEBHOOK_SECRET;
    if (!secret) {
      // Misconfigured: refuse rather than silently accept unsigned events.
      return res.status(500).json({ error: 'RevenueCat webhook not configured' });
    }
    if (!bearerOk(req.headers.authorization, secret)) {
      return res.status(401).json({ error: 'Invalid webhook authorization' });
    }

    const rawBody = await readRawBody(req);
    let body;
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return res.status(400).json({ error: 'Invalid JSON' });
    }
    const event = body?.event;
    if (!event?.id || !event?.type) {
      return res.status(400).json({ error: 'Missing event.id or event.type' });
    }

    // Dedup - RC retries on non-2xx with the same event.id.
    if (!(await markProcessed('revenuecat', event.id, null))) {
      return ok(res, { received: true, deduped: true });
    }
    claimedEventId = event.id;

    // Our appUserID == workspace id. RC also surfaces it as
    // app_user_id on the event payload.
    const workspaceId = event.app_user_id;
    if (!workspaceId) {
      // No workspace to flip - accept but no-op so RC doesn't retry.
      return ok(res, { received: true, noop: 'no app_user_id' });
    }

    const expirationMs = event.expiration_at_ms || null;
    const nowMs = Date.now();
    const nextStatus = statusForEvent(event.type, expirationMs, nowMs);
    if (!nextStatus) {
      // SUBSCRIBER_ALIAS, TEST, TRANSFER, etc. - accept silently.
      return ok(res, { received: true, ignored: event.type });
    }

    // Load the current workspace state so we can decide whether this is
    // a first-time conversion (stamp converted_at) and whether to fire
    // the started-email side effect.
    const { rows: existingRows } = await sql`
      SELECT id, owner_id, subscription_status, converted_at
      FROM workspaces
      WHERE id = ${workspaceId}
    `;
    if (existingRows.length === 0) {
      return ok(res, { received: true, noop: 'no workspace' });
    }
    const prev = existingRows[0];

    const periodEnd = expirationMs ? new Date(expirationMs) : null;
    const productId = event.product_id || null;
    const originalTxn = event.original_transaction_id || null;

    // First successful purchase ever → stamp converted_at. Subsequent
    // renewals keep the original conversion stamp so funnel metrics
    // (signup→onboarding→paywall→conversion) don't drift.
    const shouldStampConverted = !prev.converted_at && nextStatus === 'active';

    await sql`
      UPDATE workspaces
         SET subscription_status     = ${nextStatus},
             subscription_source     = 'apple',
             revenuecat_user_id      = ${workspaceId},
             apple_product_id        = COALESCE(${productId}, apple_product_id),
             apple_original_transaction_id = COALESCE(${originalTxn}, apple_original_transaction_id),
             subscription_period_end = ${periodEnd},
             subscription_past_due_since = CASE
               WHEN ${nextStatus} = 'past_due' AND subscription_past_due_since IS NULL
                 THEN NOW()
               WHEN ${nextStatus} <> 'past_due'
                 THEN NULL
               ELSE subscription_past_due_since
             END,
             converted_at = CASE
               WHEN ${shouldStampConverted} THEN NOW()
               ELSE converted_at
             END
       WHERE id = ${workspaceId}
    `;

    // Owner-facing notifications. Mirror the Stripe webhook's behavior
    // so iOS-billed owners get the same emails web-billed owners do.
    try {
      // Apple price is in microdollars on event.price_in_purchased_currency
      // (or price * 1e6 on some product types). Multiply to cents for our
      // notify helpers; they format from cents + currency.
      const amountCents = Number.isFinite(event.price)
        ? Math.round(event.price * 100)
        : null;
      const currency = event.currency || 'USD';
      if (event.type === 'INITIAL_PURCHASE') {
        await notifySubscriptionStarted({ workspaceId, periodEnd, amountCents, currency });
      } else if (event.type === 'BILLING_ISSUE') {
        await notifyPaymentFailed({ workspaceId, amountCents, currency, nextAttemptAt: null });
      } else if (event.type === 'EXPIRATION') {
        await notifySubscriptionCancelled({ workspaceId, endsAt: periodEnd });
      }
    } catch (notifyErr) {
      // Don't fail the webhook over a side-effect; RC would retry the
      // whole event and we'd re-flip status (idempotent) AND re-email.
      // eslint-disable-next-line no-console
      console.warn('[revenuecat-webhook] notify failed:', notifyErr?.message);
    }

    return ok(res, { received: true, type: event.type, status: nextStatus });
  } catch (err) {
    // Release dedup so RC's retry actually re-runs us instead of being
    // short-circuited by the marker we set above. Same pattern as the
    // Stripe webhook.
    if (claimedEventId) {
      await releaseProcessed('revenuecat', claimedEventId).catch(() => {});
    }
    return serverError(res, err);
  }
}
