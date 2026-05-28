// POST /api/webhooks/stripe-platform  (public, signature-verified)
//
// Platform-level Stripe webhook for Account-Links / Express-onboarded
// workspaces. Owners on the modern Connect flow don't paste a
// per-workspace webhook secret — events for every connected account
// arrive here using the single platform-level STRIPE_WEBHOOK_SECRET.
//
// Dispatch:
//   • Look up workspace_id from finance_settings WHERE
//     stripe_connect_user_id = event.account.
//   • Handle account.updated (status refresh).
//   • Handle checkout.session.completed for payments + save-card.
//   • Other event types succeed quietly so Stripe stops retrying.
//
// The legacy per-workspace webhook at /api/webhooks/stripe/[workspaceId]
// stays for backward compatibility — workspaces that pasted keys
// manually still ride that path.
import { sql } from '../_lib/db.js';
import { readRawBody } from '../_lib/body.js';
import {
  verifyWebhookSignature, platformWebhookSecret, platformStripeSecret,
  fetchAccountSummary, fetchPaymentMethod, setDefaultPaymentMethod,
} from '../_lib/stripe.js';
import { computeTotals } from '../_lib/finance.js';
import { applySubscriptionState } from '../_lib/memberships.js';
import { notifyOwnerSafe } from '../_lib/push.js';
import { notifyInvoicePaid } from '../_lib/invoiceNotify.js';
import { markInvoicePaid } from '../_lib/invoicePayments.js';
import { markProcessed } from '../_lib/webhookDedup.js';
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
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
      return res.status(400).json({ error: `Webhook verification failed: ${err.message}` });
    }

    // Dedup BEFORE any processing. Use a distinct 'stripe-platform'
    // provider tag so platform-level events don't collide with
    // per-workspace Connect events of the same id (they shouldn't,
    // but defense-in-depth is cheap here).
    if (!await markProcessed('stripe-platform', event.id, null)) {
      return ok(res, { received: true, deduped: true });
    }

    // event.account = the connected account id. Platform events
    // (originating from the platform itself, not a connected acct)
    // have no event.account — we no-op those.
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
      // Unknown connected acct — could be a stale acct from a workspace
      // that disconnected. Acknowledge so Stripe stops retrying.
      return ok(res, { received: true, ignored: 'unknown connected account' });
    }

    // account.updated — Stripe sends this when charges_enabled / details_submitted
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
    // move client_memberships state — created flips to 'active' when
    // checkout completes; updated handles renewals/past_due; deleted
    // marks cancelled. We require metadata.purpose='membership' so an
    // owner's other Stripe subscriptions (if any) don't get mis-routed
    // into THRYVE's membership table.
    if (event.type === 'customer.subscription.created'
     || event.type === 'customer.subscription.updated'
     || event.type === 'customer.subscription.deleted') {
      const sub = event.data?.object || {};
      const eventWorkspaceId = sub.metadata?.workspace_id;
      if (eventWorkspaceId && eventWorkspaceId !== workspaceId) {
        return res.status(400).json({ error: 'workspace mismatch' });
      }
      // No metadata.purpose gate: applySubscriptionState handles both
      // THRYVE-originated subs (metadata.purpose='membership') AND
      // Stripe-Dashboard-originated subs (matched via customer +
      // price lookups). Returns 'race' / 'mismatch' for anything that
      // doesn't resolve to a known client + tier in this workspace.
      const result = await applySubscriptionState({ workspaceId, sub });
      return ok(res, { received: true, applied: 'membership-state', result });
    }

    // checkout.session.completed — payment OR save-card flows. We
    // ignore subscription mode here because the customer.subscription.*
    // events above carry the full subscription state we need.
    if (event.type === 'checkout.session.completed') {
      const session = event.data?.object || {};
      const sessionId = session.id;
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
          const siResp = await fetch(
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

      // Payment flow: invoice or booking-deposit. Mark the invoice
      // paid + record the payment intent for refunds. Booking
      // deposits route through the bookings table separately —
      // their invoice_id starts with 'bookdep_'.
      const invoiceId = session.metadata?.invoice_id;
      if (!invoiceId) {
        return ok(res, { received: true, ignored: 'no invoice_id in metadata' });
      }
      const paymentIntent = typeof session.payment_intent === 'string'
        ? session.payment_intent : session.payment_intent?.id;

      // Booking deposit. Stash the payment intent against the booking row.
      // Idempotency guard (defense-in-depth beyond markProcessed, which
      // fails open on a dedup-table blip): only apply + notify if the
      // deposit wasn't already recorded, so a duplicate event can't
      // re-fire the owner push.
      if (invoiceId.startsWith('bookdep_')) {
        const bookingId = invoiceId.slice('bookdep_'.length);
        const dep = await sql`
          UPDATE bookings SET
            deposit_paid = deposit_required,
            deposit_paid_at = NOW(),
            deposit_payment_intent = ${paymentIntent},
            updated_at = NOW()
          WHERE id = ${bookingId} AND workspace_id = ${workspaceId}
            AND deposit_paid_at IS NULL
          RETURNING id
        `;
        if (dep.rows.length === 0) {
          return ok(res, { received: true, ignored: 'deposit already recorded' });
        }
        notifyOwnerSafe({
          workspaceId, type: 'bookings',
          payload: { title: 'Deposit paid', body: `Booking deposit for ${bookingId.slice(0, 8)} just came in.`,
            url: '/calendar', tag: `deposit-${bookingId}` },
        });
        return ok(res, { received: true, applied: 'booking-deposit' });
      }

      // Regular invoice. Mark paid + record the payment_intent.
      const inv = await sql`
        SELECT * FROM invoices
         WHERE id = ${invoiceId} AND workspace_id = ${workspaceId}
      `;
      if (inv.rows.length === 0) {
        return ok(res, { received: true, ignored: 'invoice not found' });
      }
      const i = inv.rows[0];
      // Idempotency guard matching the per-workspace handler: if already
      // paid, don't re-stamp paid_at or re-fire the receipt email / owner
      // push. markProcessed fails open on a dedup-table blip, so this is
      // the real backstop against a duplicate/replayed event.
      if (i.status === 'paid') {
        return ok(res, { received: true, ignored: 'invoice already paid' });
      }
      const totals = computeTotals(i.items, i.tax_rate, i.discount);
      // Record what was actually charged (== totals.total to the cent when
      // Stripe Tax is off; includes Stripe-computed tax when it's on).
      const paidAmount = Number.isFinite(session.amount_total)
        ? session.amount_total / 100
        : totals.total;
      const upd = await sql`
        UPDATE invoices SET
          status = 'paid',
          paid_at = NOW(),
          paid_method = 'card',
          paid_amount = ${paidAmount},
          stripe_payment_intent = ${paymentIntent},
          stripe_session_id = ${sessionId},
          updated_at = NOW()
        WHERE id = ${invoiceId} AND workspace_id = ${workspaceId}
          AND status <> 'paid'
        RETURNING id
      `;
      // Lost a race with a concurrent duplicate — it already marked paid.
      if (upd.rows.length === 0) {
        return ok(res, { received: true, ignored: 'invoice already paid' });
      }
      notifyOwnerSafe({
        workspaceId, type: 'payments',
        payload: { title: 'Invoice paid', body: `${i.number} · $${Number(paidAmount).toFixed(2)}`,
          url: `/finance?invoice=${invoiceId}`, tag: `inv-${invoiceId}` },
      });
      // Receipt email to the client. Best-effort; never blocks the
      // webhook ack so Stripe doesn't retry.
      notifyInvoicePaid({
        workspaceId, invoiceId, totalAmount: paidAmount, method: 'card',
      });
      return ok(res, { received: true, applied: 'invoice-paid' });
    }

    // payment_intent.succeeded — safety net for invoice payments. Stripe
    // fans a single Checkout payment into checkout.session.completed +
    // payment_intent.succeeded; if the former never lands (webhook
    // misconfigured, transient delivery failure, payment created outside
    // the Checkout flow via chargeOffSession), this branch still marks
    // the invoice paid. markInvoicePaid is idempotent (UPDATE guarded by
    // status<>'paid'), so the duplicate from the pair is a no-op.
    //
    // Booking-deposit PIs (metadata.invoice_id starting 'bookdep_') are
    // skipped here — those flow through checkout.session.completed only.
    if (event.type === 'payment_intent.succeeded') {
      const pi = event.data?.object || {};
      const invoiceId = pi.metadata?.invoice_id;
      const eventWorkspaceId = pi.metadata?.workspace_id;
      if (!invoiceId) {
        return ok(res, { received: true, ignored: 'no invoice_id in metadata' });
      }
      if (invoiceId.startsWith('bookdep_')) {
        return ok(res, { received: true, ignored: 'booking deposit handled via session.completed' });
      }
      if (eventWorkspaceId && eventWorkspaceId !== workspaceId) {
        return res.status(400).json({ error: 'workspace mismatch' });
      }
      const result = await markInvoicePaid({
        workspaceId, invoiceId, paymentIntent: pi.id,
        amountCents: pi.amount_received,
      });
      return ok(res, { received: true, applied: 'invoice-paid', result });
    }

    // All other event types — quietly accept so Stripe stops retrying.
    return ok(res, { received: true, ignored: event.type });
  } catch (err) {
    return serverError(res, err);
  }
}
