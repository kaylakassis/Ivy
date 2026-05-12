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
import { notifyOwnerSafe } from '../_lib/push.js';
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

    // checkout.session.completed — payment OR save-card flows. We
    // ignore subscription mode here; recurring billing still rides
    // the legacy per-workspace webhook because membership lifecycle
    // is more involved. v2 can subsume that.
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
      if (invoiceId.startsWith('bookdep_')) {
        const bookingId = invoiceId.slice('bookdep_'.length);
        await sql`
          UPDATE bookings SET
            deposit_paid = deposit_required,
            deposit_paid_at = NOW(),
            deposit_payment_intent = ${paymentIntent},
            updated_at = NOW()
          WHERE id = ${bookingId} AND workspace_id = ${workspaceId}
        `;
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
      const totals = computeTotals(i.items, i.tax_rate, i.discount);
      await sql`
        UPDATE invoices SET
          status = 'paid',
          paid_at = NOW(),
          paid_method = 'card',
          paid_amount = ${totals.total},
          stripe_payment_intent = ${paymentIntent},
          stripe_session_id = ${sessionId},
          updated_at = NOW()
        WHERE id = ${invoiceId} AND workspace_id = ${workspaceId}
      `;
      notifyOwnerSafe({
        workspaceId, type: 'finance',
        payload: { title: 'Invoice paid', body: `${i.number} · $${Number(totals.total).toFixed(2)}`,
          url: `/finance?invoice=${invoiceId}`, tag: `inv-${invoiceId}` },
      });
      return ok(res, { received: true, applied: 'invoice-paid' });
    }

    // All other event types — quietly accept so Stripe stops retrying.
    return ok(res, { received: true, ignored: event.type });
  } catch (err) {
    return serverError(res, err);
  }
}
