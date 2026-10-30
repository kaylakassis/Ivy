// POST /api/webhooks/stripe-platform  (public, signature-verified)
//
// Platform-level Stripe webhook for Account-Links / Express-onboarded
// workspaces. Owners on the modern Connect flow don't paste a
// per-workspace webhook secret - events for every connected account
// arrive here using the single platform-level STRIPE_WEBHOOK_SECRET.
//
// Dispatch:
//   • Look up workspace_id from finance_settings WHERE
//     stripe_connect_user_id = event.account.
//   • Handle account.updated (status refresh).
//   • Handle checkout.session.completed for payments + save-card, and the
//     checkout.session.async_payment_{succeeded,failed} pair that delayed
//     methods (ACH Direct Debit) settle through.
//   • Other event types succeed quietly so Stripe stops retrying.
//
// The legacy per-workspace webhook at /api/webhooks/stripe/[workspaceId]
// stays for backward compatibility - workspaces that pasted keys
// manually still ride that path.
import { sql } from '../_lib/db.js';
import { readRawBody } from '../_lib/body.js';
import {
  verifyWebhookSignature, platformWebhookSecret, platformStripeSecret,
  fetchAccountSummary, fetchPaymentMethod, setDefaultPaymentMethod,
} from '../_lib/stripe.js';
import { applySubscriptionState } from '../_lib/memberships.js';
import { applyProgramSubscription } from '../_lib/programs.js';
import {
  fulfillCheckoutSession, fulfillInvoicePaymentIntent, failInvoiceAsyncPayment,
  syncRefundToPurchases,
} from '../_lib/checkoutFulfillment.js';
import { notifyOwnerSafe } from '../_lib/push.js';
import { markProcessed, releaseProcessed } from '../_lib/webhookDedup.js';
import { fetchWithTimeout } from '../_lib/fetchTimeout.js';
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';
import { recordWebhookFailure, SIGNATURE_FAILURE } from '../_lib/webhookFailures.js';

export const config = { api: { bodyParser: false } };

// Platform secret + Stripe-Account header for follow-up API calls on the
// connected account (saved-card lookups). Null when the platform key is
// not configured so fulfilment simply skips those extras.
function platformCreds(acctId) {
  const secretKey = platformStripeSecret();
  return secretKey ? { secretKey, stripeAccount: acctId } : null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  // Tracked across the try so the catch can release the dedup claim and
  // let Stripe's retry re-process the event instead of getting silently
  // deduped on a transient error. Same pattern as stripe/[workspaceId].js.
  let claimedEventId = null;
  let eventType = null;
  try {
    const secret = platformWebhookSecret();
    if (!secret) {
      return res.status(500).json({ error: 'Platform webhook secret not configured' });
    }

    const rawBody = await readRawBody(req);
    let event;
    try {
      event = verifyWebhookSignature({
        payload: rawBody,
        header: req.headers['stripe-signature'],
        secret,
      });
    } catch (err) {
      await recordWebhookFailure({ source: 'stripe-platform', eventType: SIGNATURE_FAILURE, message: err.message });
      return res.status(400).json({ error: `Webhook verification failed: ${err.message}` });
    }
    eventType = event.type;

    // Dedup BEFORE any processing. Use a distinct 'stripe-platform'
    // provider tag so platform-level events don't collide with
    // per-workspace Connect events of the same id (they shouldn't,
    // but defense-in-depth is cheap here).
    if (!await markProcessed('stripe-platform', event.id, null)) {
      return ok(res, { received: true, deduped: true });
    }
    claimedEventId = event.id;

    // event.account = the connected account id. Platform events
    // (originating from the platform itself, not a connected acct)
    // have no event.account - we no-op those.
    const acctId = event.account;
    if (!acctId) {
      return ok(res, { received: true, ignored: 'platform-level event (no connected account)' });
    }

    const { rows } = await sql`
      SELECT workspace_id FROM finance_settings
       WHERE stripe_connect_user_id = ${acctId}
       LIMIT 1
    `;
    const workspaceId = rows[0]?.workspace_id;
    if (!workspaceId) {
      // Unknown connected acct - could be a stale acct from a workspace
      // that disconnected. Acknowledge so Stripe stops retrying.
      return ok(res, { received: true, ignored: 'unknown connected account' });
    }

    // account.updated - Stripe sends this when charges_enabled / details_submitted
    // / payouts_enabled flips. Resync the local row so the owner's
    // /finance page reflects current status without a manual refresh.
    if (event.type === 'account.updated') {
      try {
        const platformKey = platformStripeSecret();
        if (platformKey) {
          const summary = await fetchAccountSummary({
            secretKey: platformKey, stripeAccount: acctId,
          });
          const status = summary.chargesEnabled ? 'complete' : 'pending';
          await sql`
            UPDATE finance_settings SET
              stripe_account_label     = ${summary.label},
              stripe_connect_livemode  = ${!!summary.livemode},
              stripe_onboarding_status = ${status}
            WHERE workspace_id = ${workspaceId}
          `;
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[stripe-platform] account.updated refresh failed:', err.message);
      }
      return ok(res, { received: true, applied: 'account-status' });
    }

    // Membership subscription lifecycle. customer.subscription.* events
    // move client_memberships state - created flips to 'active' when
    // checkout completes; updated handles renewals/past_due; deleted
    // marks cancelled. We require metadata.purpose='membership' so an
    // owner's other Stripe subscriptions (if any) don't get mis-routed
    // into Ivy's membership table.
    if (event.type === 'customer.subscription.created'
     || event.type === 'customer.subscription.updated'
     || event.type === 'customer.subscription.deleted') {
      const sub = event.data?.object || {};
      const eventWorkspaceId = sub.metadata?.workspace_id;
      if (eventWorkspaceId && eventWorkspaceId !== workspaceId) {
        return res.status(400).json({ error: 'workspace mismatch' });
      }
      // No metadata.purpose gate: applySubscriptionState handles both
      // Ivy-originated subs (metadata.purpose='membership') AND
      // Stripe-Dashboard-originated subs (matched via customer +
      // price lookups). Returns 'race' / 'mismatch' for anything that
      // doesn't resolve to a known client + tier in this workspace.
      // stripeContext lets it fetch unknown customers and auto-provision
      // a clients row when the Dashboard-originated path can't match.
      // Programs sold on a subscription carry metadata.purpose='program';
      // their access lives in program_enrollments, not memberships.
      if (sub.metadata?.purpose === 'program') {
        const result = await applyProgramSubscription({ workspaceId, sub });
        return ok(res, { received: true, applied: 'program-subscription', result });
      }
      const platformKey = platformStripeSecret();
      const result = await applySubscriptionState({
        workspaceId, sub,
        stripeContext: platformKey ? { secretKey: platformKey, stripeAccount: acctId } : undefined,
      });
      return ok(res, { received: true, applied: 'membership-state', result });
    }

    // checkout.session.completed - payment OR save-card flows. We
    // ignore subscription mode here because the customer.subscription.*
    // events above carry the full subscription state we need.
    if (event.type === 'checkout.session.completed') {
      const session = event.data?.object || {};
      const eventWorkspaceId = session.metadata?.workspace_id;

      // Defense-in-depth: if metadata supplied a workspace, it must match.
      if (eventWorkspaceId && eventWorkspaceId !== workspaceId) {
        return res.status(400).json({ error: 'workspace mismatch' });
      }

      // Save-card flow (client portal "save card on file").
      if (session.mode === 'setup' && session.metadata?.purpose === 'save_card') {
        const clientId = session.metadata?.client_id;
        const setupIntentId = typeof session.setup_intent === 'string'
          ? session.setup_intent : session.setup_intent?.id;
        if (!clientId || !setupIntentId) {
          return ok(res, { received: true, ignored: 'setup metadata incomplete' });
        }
        try {
          const platformKey = platformStripeSecret();
          if (!platformKey) return ok(res, { received: true, ignored: 'no platform secret' });

          // Re-fetch the SetupIntent against the connected acct to
          // get the payment_method id.
          const siHeaders = {
            Authorization: `Bearer ${platformKey}`,
            'Stripe-Account': acctId,
            Accept: 'application/json',
          };
          const siResp = await fetchWithTimeout(
            `https://api.stripe.com/v1/setup_intents/${encodeURIComponent(setupIntentId)}`,
            { headers: siHeaders },
          );
          const si = await siResp.json();
          if (!siResp.ok) {
            return ok(res, { received: true, ignored: 'setup_intent fetch failed' });
          }
          const paymentMethodId = typeof si.payment_method === 'string'
            ? si.payment_method : si.payment_method?.id;
          if (!paymentMethodId) {
            return ok(res, { received: true, ignored: 'no payment_method on setup_intent' });
          }
          const pm = await fetchPaymentMethod({
            secretKey: platformKey, stripeAccount: acctId, paymentMethodId,
          });
          const card = pm.card || {};
          await sql`
            UPDATE clients SET
              payment_method_id = ${paymentMethodId},
              payment_method_brand = ${card.brand || null},
              payment_method_last4 = ${card.last4 || null},
              payment_method_exp_month = ${card.exp_month || null},
              payment_method_exp_year = ${card.exp_year || null},
              updated_at = NOW()
            WHERE id = ${clientId} AND workspace_id = ${workspaceId}
          `;
          if (typeof session.customer === 'string') {
            try {
              await setDefaultPaymentMethod({
                secretKey: platformKey, stripeAccount: acctId,
                customerId: session.customer, paymentMethodId,
              });
            } catch { /* non-fatal */ }
          }
          return ok(res, { received: true, marked: 'card-saved' });
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('[stripe-platform] save-card flow failed:', err.message);
          return ok(res, { received: true, ignored: 'save-card error: ' + err.message });
        }
      }

      // Everything else a mode='payment' session can be - invoice, booking
      // deposit, package, program, gift card - goes through the shared
      // fulfilment dispatcher. It fulfils ONLY when payment_status is
      // 'paid'; an ACH Direct Debit session arrives 'unpaid' and is stamped
      // "payment processing" until async_payment_succeeded lands below.
      const result = await fulfillCheckoutSession({ workspaceId, session, creds: platformCreds(acctId) });
      return ok(res, { received: true, ...result });
    }

    // Delayed payment methods (ACH Direct Debit): the debit settled.
    // Same idempotent fulfilment as a paid checkout.session.completed.
    if (event.type === 'checkout.session.async_payment_succeeded') {
      const session = event.data?.object || {};
      const eventWorkspaceId = session.metadata?.workspace_id;
      if (eventWorkspaceId && eventWorkspaceId !== workspaceId) {
        return res.status(400).json({ error: 'workspace mismatch' });
      }
      const result = await fulfillCheckoutSession({ workspaceId, session, creds: platformCreds(acctId), settledAsync: true });
      return ok(res, { received: true, ...result });
    }

    // The debit bounced: leave the invoice unpaid, clear "processing",
    // tell the owner and send the client a link to pay again.
    if (event.type === 'checkout.session.async_payment_failed') {
      const session = event.data?.object || {};
      const eventWorkspaceId = session.metadata?.workspace_id;
      if (eventWorkspaceId && eventWorkspaceId !== workspaceId) {
        return res.status(400).json({ error: 'workspace mismatch' });
      }
      if (!session.metadata?.invoice_id || String(session.metadata.invoice_id).startsWith('bookdep_')) {
        return ok(res, { received: true, ignored: 'async failure outside the invoice flow' });
      }
      const result = await failInvoiceAsyncPayment({ workspaceId, session });
      return ok(res, { received: true, applied: 'invoice-payment-failed', result });
    }

    // payment_intent.succeeded - safety net for invoice payments. Stripe
    // fans a single Checkout payment into checkout.session.completed +
    // payment_intent.succeeded; if the former never lands (webhook
    // misconfigured, transient delivery failure, payment created outside
    // the Checkout flow via chargeOffSession), this branch still marks
    // the invoice paid. markInvoicePaid is idempotent (UPDATE guarded by
    // status<>'paid'), so the duplicate from the pair is a no-op.
    //
    // Booking-deposit PIs (metadata.invoice_id starting 'bookdep_') are
    // skipped here - those flow through checkout.session.completed only.
    if (event.type === 'payment_intent.succeeded') {
      const pi = event.data?.object || {};
      const eventWorkspaceId = pi.metadata?.workspace_id;
      if (eventWorkspaceId && eventWorkspaceId !== workspaceId) {
        return res.status(400).json({ error: 'workspace mismatch' });
      }

      // Order checkout from /site/:handle/checkout. Marks the orders
      // row paid + decrements stock for any tracked products. Same
      // idempotency pattern as the invoice path (UPDATE … WHERE
      // status='pending'); a duplicate event is a no-op.
      if (pi.metadata?.order_id) {
        const { markOrderPaidFromPI } = await import('../_lib/checkoutFulfillment.js');
        const result = await markOrderPaidFromPI({ workspaceId, pi });
        return ok(res, { received: true, ...result });
      }

      // Invoice safety-net path (unchanged).
      const invoiceId = pi.metadata?.invoice_id;
      if (!invoiceId) {
        return ok(res, { received: true, ignored: 'no invoice_id or order_id in metadata' });
      }
      if (invoiceId.startsWith('bookdep_')) {
        return ok(res, { received: true, ignored: 'booking deposit handled via session.completed' });
      }
      const result = await fulfillInvoicePaymentIntent({ workspaceId, pi, creds: platformCreds(acctId) });
      return ok(res, { received: true, applied: 'invoice-paid', result });
    }

    // charge.refunded - a refund issued OUTSIDE Ivy (straight from the
    // Stripe Dashboard, or by Stripe on a dispute). Without this, the
    // invoice stays 'paid' and the owner's revenue numbers overstate.
    // Mirrors api/_lib/refunds.js semantics: refunded_amount is the
    // CUMULATIVE dollars refunded (charge.amount_refunded is cumulative
    // cents, so an absolute set is naturally idempotent - the echo of an
    // Ivy-initiated refund lands on identical values and no-ops).
    if (event.type === 'charge.refunded') {
      const charge = event.data?.object || {};
      const pi = typeof charge.payment_intent === 'string'
        ? charge.payment_intent : charge.payment_intent?.id;
      if (!pi) return ok(res, { received: true, ignored: 'no payment_intent on charge' });

      const inv = await sql`
        SELECT id, number, activity, refunded_amount FROM invoices
         WHERE workspace_id = ${workspaceId} AND stripe_payment_intent = ${pi}
         LIMIT 1
      `;
      if (inv.rows.length === 0) {
        // Gift cards and packages have no invoice row: void the card /
        // cancel the bundle so refunded money cannot keep being spent.
        // Booking deposits / orders track refunds separately; unmatched
        // charges are acknowledged so Stripe stops retrying.
        const synced = await syncRefundToPurchases({ workspaceId, charge });
        return ok(res, { received: true, ...synced });
      }
      const i = inv.rows[0];
      const refundedTotal = Math.round(Number(charge.amount_refunded || 0)) / 100;
      const already = Number(i.refunded_amount || 0);
      if (refundedTotal <= already) {
        return ok(res, { received: true, ignored: 'refund already recorded' });
      }
      const fully = Number(charge.amount_refunded) >= Number(charge.amount);
      const entry = {
        ts: new Date().toISOString(),
        kind: 'refund',
        text: `Refunded $${(refundedTotal - already).toFixed(2)} to card (via Stripe)`,
      };
      const applied = await sql`
        UPDATE invoices SET
          status          = ${fully ? 'refunded' : 'paid'},
          refunded_amount = ${refundedTotal},
          refunded_at     = NOW(),
          activity        = ${JSON.stringify([...(i.activity || []), entry])}::jsonb,
          updated_at      = NOW()
        WHERE id = ${i.id} AND workspace_id = ${workspaceId}
          AND COALESCE(refunded_amount, 0) = ${already}
        RETURNING id
      `;
      if (applied.rowCount > 0) {
        const { notifyInvoiceRefunded } = await import('../_lib/invoiceNotify.js');
        await notifyInvoiceRefunded({ workspaceId, invoiceId: i.id, amount: Math.round((refundedTotal - already) * 100) / 100 }).catch(() => {});
      }
      notifyOwnerSafe({
        workspaceId, type: 'payments',
        payload: {
          title: fully ? 'Invoice refunded' : 'Partial refund recorded',
          body: `${i.number} · $${refundedTotal.toFixed(2)} refunded via Stripe`,
          url: `/finance?invoice=${i.id}`,
          tag: `refund-${i.id}`,
        },
      });
      return ok(res, { received: true, applied: 'invoice-refund-synced' });
    }

    // All other event types - quietly accept so Stripe stops retrying.
    return ok(res, { received: true, ignored: event.type });
  } catch (err) {
    // Processing threw after we claimed the event - release the claim so
    // Stripe's retry re-runs the handler rather than getting deduped.
    if (claimedEventId) await releaseProcessed('stripe-platform', claimedEventId);
    await recordWebhookFailure({ source: 'stripe-platform', eventType: eventType || 'processing', message: err.message });
    return serverError(res, err);
  }
}
