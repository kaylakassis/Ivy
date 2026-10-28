// POST /api/invoice-pay/:token  (public, no auth)
// Creates a Stripe Checkout Session for the invoice this token represents
// and returns its URL. The browser redirects there; on completion Stripe
// posts to /api/webhooks/stripe/<workspaceId> which marks the invoice paid.
//
// Token authentication is identical to /api/invoice-view/:token - the same
// sha256-hashed view token must match an invoice in 'sent' or 'overdue'.
//
// Idempotent-ish: a second call replaces the stored session id with a fresh
// one. Stripe doesn't auto-expire abandoned sessions for hours, so reusing
// the previous URL would also work - but issuing a new session is simpler
// than tracking expiry on our side.
import { sql } from '../_lib/db.js';
import { readBody } from '../_lib/body.js';
import { enforce, getClientIp } from '../_lib/rate-limit.js';
import { computeTotals } from '../_lib/finance.js';
import { getProvider } from '../_lib/payments/index.js';
import { reconcileStripeInvoice } from '../_lib/invoicePayments.js';
import { loadStripeCreds } from '../_lib/stripeCreds.js';
import { savedCardRowForInvoice, ensureStripeCustomer, chargeInvoiceWithSavedCard } from '../_lib/savedCards.js';
import { fulfillInvoicePaymentIntent, markInvoiceProcessing } from '../_lib/checkoutFulfillment.js';
import { appUrl } from '../_lib/tokens.js';
import { badRequest, methodNotAllowed, notFound, ok, serverError } from '../_lib/json.js';
import crypto from 'node:crypto';

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try {
    const ip = getClientIp(req);
    const blocked = await enforce(req, res, [
      { key: `invpay:ip:${ip}`, max: 10, windowSeconds: 60 * 60 },
    ]);
    if (blocked) return;

    const rawToken = (req.query.token || '').toString();
    if (typeof rawToken !== 'string' || rawToken.length < 16) {
      return notFound(res, 'Invalid invoice link.');
    }
    const tokenHash = hashToken(rawToken);

    // Confirm action: the buyer just returned from Checkout (?paid=1). Mark
    // the invoice paid synchronously by reading the completed session -
    // don't wait on the per-workspace webhook (which most owners never set
    // up, so payments silently never landed in the finance tab). Idempotent.
    if (req.query.action === 'confirm') {
      const { rows } = await sql`SELECT * FROM invoices WHERE view_token_hash = ${tokenHash} LIMIT 1`;
      const inv = rows[0];
      // Token is cleared once an invoice is paid - a not-found here in the
      // post-checkout return flow means it already settled.
      if (!inv) return ok(res, { paid: true });
      if (inv.status === 'paid' || inv.status === 'refunded') return ok(res, { paid: true });
      const paid = await reconcileStripeInvoice(inv);
      // A bank debit (ACH) completes Checkout 'unpaid' and settles later:
      // the page must say "processing", not "paid".
      const fresh = await sql`SELECT payment_processing_at FROM invoices WHERE id = ${inv.id}`;
      return ok(res, { paid, processing: !paid && !!fresh.rows[0]?.payment_processing_at });
    }

    const { rows: invRows } = await sql`
      SELECT * FROM invoices
      WHERE view_token_hash = ${tokenHash}
        AND status IN ('sent', 'overdue')
      LIMIT 1
    `;
    const inv = invRows[0];
    if (!inv) return notFound(res, 'This invoice link is invalid, has expired, or was already paid.');

    // A debit that is still settling must not be paid twice.
    if (inv.payment_processing_at) {
      return badRequest(res, 'A bank payment for this invoice is already on its way. It usually clears within 4 business days.');
    }

    const body = await readBody(req).catch(() => ({}));
    const wantsSaveCard = body?.saveCard === true || body?.saveCard === 'true';
    const useSavedCard = body?.useSavedCard === true || body?.useSavedCard === 'true';

    const totals = computeTotals(inv.items || [], inv.tax_rate, inv.discount);
    if (!(totals.total > 0)) return badRequest(res, 'Nothing to pay on this invoice.');
    const totalCents = Math.round(totals.total * 100);

    const base = appUrl();
    const successUrl = `${base}/invoice/${encodeURIComponent(rawToken)}?paid=1`;
    const cancelUrl  = `${base}/invoice/${encodeURIComponent(rawToken)}?cancelled=1`;

    // Multi-provider checkout. The workspace's selected payment_provider
    // (Stripe / Square / PayPal) decides which adapter mints the link.
    // Each adapter throws if it isn't connected - we surface the
    // friendly message back to the public-pay page.
    let session;
    try {
      const { adapter, name, settings } = await getProvider(inv.workspace_id);
      // When Stripe Tax is the source of truth it adds tax on top of the
      // amount we send (tax_behavior=exclusive). The invoice's own tax_rate
      // is already baked into `totals.total`, so sending that would tax the
      // buyer twice. Send the tax-exclusive base and let Stripe be the only
      // tax layer. (No-op when stripe tax is off, or tax_rate is already 0.)
      let amountCents = (name === 'stripe' && settings?.stripeTaxEnabled)
        ? Math.round((totals.total - totals.tax) * 100)
        : totalCents;
      // Partial payments already recorded reduce what this link collects -
      // charging the full recomputed total again over-collected.
      const alreadyPaidCents = Math.round(Number(inv.paid_amount || 0) * 100);
      if (alreadyPaidCents > 0) {
        amountCents = Math.max(0, amountCents - alreadyPaidCents);
        if (amountCents === 0) return badRequest(res, 'Nothing left to pay on this invoice.');
      }
      const currency = (inv.currency || settings?.currency || 'USD').toUpperCase();

      // Saved card (Stripe only). The card lives on THIS business's
      // connected account and is read through the invoice's own client row,
      // so it is never offered across businesses.
      let customerId = null;
      let savedClient = null;
      if (name === 'stripe' && inv.client_id && (wantsSaveCard || useSavedCard)) {
        savedClient = await savedCardRowForInvoice(inv);
      }

      // One tap: charge the saved card off-session and fulfil through the
      // same path a Checkout payment uses. A bank that insists on 3DS
      // (requires_action) falls back to the normal Checkout below; a
      // decline tells the client to pay another way.
      if (useSavedCard) {
        if (name !== 'stripe' || !savedClient?.payment_method_id) {
          return badRequest(res, 'There is no saved card for this business. Pay by card below.');
        }
        const creds = await loadStripeCreds(inv.workspace_id);
        const charge = await chargeInvoiceWithSavedCard({ creds, inv, client: savedClient, amountCents, currency });
        if (charge.outcome === 'succeeded' && !charge.processing) {
          const result = await fulfillInvoicePaymentIntent({ workspaceId: inv.workspace_id, pi: charge.paymentIntent, creds, method: 'card' });
          return ok(res, { paid: result === 'paid' || result === 'already-paid', result });
        }
        if (charge.outcome === 'succeeded' && charge.processing) {
          await markInvoiceProcessing({ workspaceId: inv.workspace_id, invoiceId: inv.id, session: { id: null, payment_intent: charge.paymentIntent.id, amount_total: amountCents, payment_method_types: ['card'] } });
          return ok(res, { paid: false, processing: true });
        }
        if (charge.outcome === 'declined') {
          return res.status(402).json({ error: charge.message || 'Your saved card was declined.', code: 'saved_card_declined' });
        }
        // requires_action: fall through to a normal Checkout session so the
        // client can authenticate with their bank there.
        customerId = savedClient.stripe_customer_id || null;
      }

      let saveCard = false;
      if (wantsSaveCard && name === 'stripe' && savedClient?.email) {
        try {
          const creds = await loadStripeCreds(inv.workspace_id);
          customerId = await ensureStripeCustomer({ creds, client: savedClient });
          saveCard = !!customerId;
        } catch (e) {
          // Saving is a nicety; the payment itself still goes ahead.
          console.warn('[invoice-pay] could not prepare saved card:', e.message);
        }
      }

      session = await adapter.createCheckoutSession({
        workspaceId: inv.workspace_id,
        settings,
        amountCents,
        // The invoice's own currency wins - it is validated at creation.
        // Falling back to the workspace default charged an EUR invoice's
        // numeric total in USD.
        currency,
        description: `Invoice ${inv.number}`,
        metadata: { invoice_id: inv.id, invoice_number: inv.number, workspace_id: inv.workspace_id, ...(name === 'stripe' && inv.client_id ? { client_id: inv.client_id } : {}) },
        successUrl,
        cancelUrl,
        customerEmail: inv.client_email || undefined,
        customerId,
        saveCard,
      });
      // Stash the provider session id so reconciliation jobs can
      // correlate later. The same column is reused across providers.
      await sql`
        UPDATE invoices SET stripe_session_id = ${session.sessionId}, updated_at = NOW()
        WHERE id = ${inv.id}
      `;
    } catch (e) {
      return badRequest(res, e.message || 'Online payment is not enabled for this invoice.');
    }

    return ok(res, { url: session.url, fallback: useSavedCard ? 'requires_action' : undefined });
  } catch (err) {
    return serverError(res, err);
  }
}
