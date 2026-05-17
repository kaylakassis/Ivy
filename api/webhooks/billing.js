// POST /api/webhooks/billing  (public, signature-verified)
// THRYVE-side Stripe webhook — handles the subscription lifecycle for
// workspaces. Verified against THRYVE_STRIPE_WEBHOOK_SECRET, scoped to a
// single platform Stripe account, NOT the per-workspace customer-Stripe
// (those land in /api/webhooks/stripe/<workspaceId>).
//
// Source of truth for subscription_status — the /api/billing/sync endpoint
// is just race-mitigation for the redirect→webhook gap.
//
// Body parsing disabled because Stripe-Signature is computed over the raw
// bytes; any re-encoding breaks verification.
import { sql } from '../_lib/db.js';
import { readRawBody } from '../_lib/body.js';
import { verifyWebhookSignature, fetchSubscription, platformStripeSecret, platformWebhookSecret } from '../_lib/stripe.js';
import { mapStripeStatus } from '../_lib/billing.js';
import { attributePayment, monthlyValueCents } from '../_lib/affiliateAttribution.js';
import {
  notifySubscriptionStarted, notifyUpcomingRenewal,
  notifyPaymentFailed, notifySubscriptionCancelled,
} from '../_lib/subscriptionNotify.js';
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';

// Stripe statuses that count as "this user is paying us". Trialing is
// excluded — affiliates only earn attribution on real revenue.
const PAYING_STATUSES = new Set(['active', 'past_due']);

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try {
    const secretKey     = platformStripeSecret();
    const webhookSecret = platformWebhookSecret();
    if (!secretKey || !webhookSecret) {
      return res.status(500).json({ error: 'THRYVE Stripe billing is not configured' });
    }

    const rawBody = await readRawBody(req);
    let event;
    try {
      event = verifyWebhookSignature({
        payload: rawBody,
        header: req.headers['stripe-signature'],
        secret: webhookSecret,
      });
    } catch (err) {
      return res.status(400).json({ error: `Webhook verification failed: ${err.message}` });
    }

    switch (event.type) {
      case 'checkout.session.completed':
        await onCheckoutCompleted(event.data.object, secretKey);
        break;

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await onSubscriptionChanged(event.data.object, event.type);
        break;

      case 'invoice.upcoming':
        await onInvoiceUpcoming(event.data.object);
        break;

      case 'invoice.payment_succeeded':
      case 'invoice.payment_failed':
        await onInvoiceEvent(event.data.object, event.type, secretKey);
        break;

      default:
        // Quietly ack anything else so Stripe stops retrying.
        return ok(res, { received: true, ignored: event.type });
    }
    return ok(res, { received: true });
  } catch (err) {
    return serverError(res, err);
  }
}

// First-time subscribe: workspace_id is in metadata; subscription details
// come either inline (when expanded) or via a follow-up fetch.
async function onCheckoutCompleted(session, secretKey) {
  const workspaceId = session.metadata?.workspace_id;
  if (!workspaceId) return;
  if (session.mode !== 'subscription') return;

  let sub = null;
  if (session.subscription) {
    sub = typeof session.subscription === 'object'
      ? session.subscription
      : await fetchSubscription({ secretKey, subscriptionId: session.subscription });
  }

  const status = sub ? mapStripeStatus(sub.status) : 'active';
  const periodEnd = sub?.current_period_end
    ? new Date(sub.current_period_end * 1000)
    : null;

  await sql`
    UPDATE workspaces SET
      subscription_status     = ${status},
      stripe_customer_id      = ${session.customer || null},
      stripe_subscription_id  = ${sub?.id || null},
      subscription_period_end = ${periodEnd}
    WHERE id = ${workspaceId}
  `;

  if (PAYING_STATUSES.has(status)) {
    await attributePayment({
      workspaceId,
      valueCents: monthlyValueCents(sub),
    }).catch((e) => console.warn('[billing] attribute on checkout failed:', e.message));
  }

  // Fire-and-forget welcome email to the owner.
  notifySubscriptionStarted({
    workspaceId,
    periodEnd,
    amountCents: sub?.items?.data?.[0]?.price?.unit_amount,
    currency:    sub?.items?.data?.[0]?.price?.currency || 'usd',
  });
}

// Mid-life updates: renewals, plan changes, cancellations. Match by
// stripe_subscription_id since that's stable across the sub's lifetime.
// Fall back to metadata.workspace_id when the row hasn't been linked yet.
async function onSubscriptionChanged(sub, eventType) {
  const workspaceId = sub.metadata?.workspace_id || null;
  const status = mapStripeStatus(sub.status);
  const periodEnd = sub.current_period_end
    ? new Date(sub.current_period_end * 1000)
    : null;

  // Try by subscription id first.
  const updated = await sql`
    UPDATE workspaces SET
      subscription_status     = ${status},
      subscription_period_end = ${periodEnd}
    WHERE stripe_subscription_id = ${sub.id}
    RETURNING id
  `;
  let resolvedWorkspaceId = updated.rows[0]?.id || null;
  if (updated.rows.length === 0 && workspaceId) {
    await sql`
      UPDATE workspaces SET
        subscription_status     = ${status},
        stripe_subscription_id  = ${sub.id},
        stripe_customer_id      = ${sub.customer || null},
        subscription_period_end = ${periodEnd}
      WHERE id = ${workspaceId}
    `;
    resolvedWorkspaceId = workspaceId;
  }

  if (resolvedWorkspaceId && PAYING_STATUSES.has(status)) {
    await attributePayment({
      workspaceId: resolvedWorkspaceId,
      valueCents: monthlyValueCents(sub),
    }).catch((e) => console.warn('[billing] attribute on sub change failed:', e.message));
  }

  // Cancellation email — fires on customer.subscription.deleted, but
  // Stripe will also send subscription.updated with status 'canceled'
  // when cancel_at_period_end fires. Trigger on either signal.
  if (resolvedWorkspaceId && (eventType === 'customer.subscription.deleted' || status === 'canceled')) {
    notifySubscriptionCancelled({
      workspaceId: resolvedWorkspaceId,
      endsAt: periodEnd,
    });
  }
}

// Stripe fires `invoice.upcoming` ~3 days before the renewal lands.
// Use it for a heads-up email rather than maintaining a separate cron.
async function onInvoiceUpcoming(invoice) {
  const subId = invoice.subscription;
  if (!subId) return;
  const { rows } = await sql`
    SELECT id FROM workspaces WHERE stripe_subscription_id = ${subId} LIMIT 1
  `;
  const workspaceId = rows[0]?.id;
  if (!workspaceId) return;
  const periodEnd = invoice.next_payment_attempt
    ? new Date(invoice.next_payment_attempt * 1000)
    : (invoice.period_end ? new Date(invoice.period_end * 1000) : null);
  notifyUpcomingRenewal({
    workspaceId,
    periodEnd,
    amountCents: invoice.amount_due,
    currency: invoice.currency || 'usd',
  });
}

// Renewals: invoice.payment_succeeded refreshes period_end and forces
// status back to 'active' (in case we'd flagged past_due). Failures move
// us to past_due so the UI can warn — Stripe's smart retry handles the
// actual recovery without us needing to do anything.
async function onInvoiceEvent(invoice, type, secretKey) {
  const subId = invoice.subscription;
  if (!subId) return;
  const sub = await fetchSubscription({ secretKey, subscriptionId: subId });
  const status = type === 'invoice.payment_failed' ? 'past_due' : mapStripeStatus(sub.status);
  const periodEnd = sub.current_period_end
    ? new Date(sub.current_period_end * 1000)
    : null;

  // Dunning bookkeeping. On payment_failed: stamp past_due_since on
  // the FIRST failure (subsequent failures during the same outage
  // keep the original timestamp so the grace clock doesn't reset),
  // and bump failed_attempts. On payment_succeeded: clear past_due
  // bookkeeping completely so a recovered subscription leaves no
  // ghosts. The api/cron/subscription-dunning cron reads
  // past_due_since to decide when to suspend.
  let r;
  if (type === 'invoice.payment_failed') {
    r = await sql`
      UPDATE workspaces SET
        subscription_status     = ${status},
        subscription_period_end = ${periodEnd},
        subscription_past_due_since = COALESCE(subscription_past_due_since, NOW()),
        subscription_failed_attempts = subscription_failed_attempts + 1
      WHERE stripe_subscription_id = ${sub.id}
      RETURNING id
    `;
  } else if (type === 'invoice.payment_succeeded') {
    r = await sql`
      UPDATE workspaces SET
        subscription_status         = ${status},
        subscription_period_end     = ${periodEnd},
        subscription_past_due_since = NULL,
        subscription_failed_attempts = 0,
        subscription_suspended_at   = NULL,
        subscription_last_dunning_at = NULL
      WHERE stripe_subscription_id = ${sub.id}
      RETURNING id
    `;
  } else {
    r = await sql`
      UPDATE workspaces SET
        subscription_status     = ${status},
        subscription_period_end = ${periodEnd}
      WHERE stripe_subscription_id = ${sub.id}
      RETURNING id
    `;
  }

  if (type === 'invoice.payment_succeeded' && r.rows[0]?.id) {
    await attributePayment({
      workspaceId: r.rows[0].id,
      valueCents: monthlyValueCents(sub),
    }).catch((e) => console.warn('[billing] attribute on invoice success failed:', e.message));
  }

  if (type === 'invoice.payment_failed' && r.rows[0]?.id) {
    notifyPaymentFailed({
      workspaceId: r.rows[0].id,
      amountCents: invoice.amount_due,
      currency: invoice.currency || 'usd',
      nextAttemptAt: invoice.next_payment_attempt
        ? new Date(invoice.next_payment_attempt * 1000) : null,
    });
  }
}
