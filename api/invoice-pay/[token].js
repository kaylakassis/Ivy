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
import { enforce, getClientIp } from '../_lib/rate-limit.js';
import { computeTotals } from '../_lib/finance.js';
import { getProvider } from '../_lib/payments/index.js';
import { reconcileStripeInvoice } from '../_lib/invoicePayments.js';
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
      return ok(res, { paid });
    }

    const { rows: invRows } = await sql`
      SELECT * FROM invoices
      WHERE view_token_hash = ${tokenHash}
        AND status IN ('sent', 'overdue')
      LIMIT 1
    `;
    const inv = invRows[0];
    if (!inv) return notFound(res, 'This invoice link is invalid, has expired, or was already paid.');

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
      session = await adapter.createCheckoutSession({
        workspaceId: inv.workspace_id,
        settings,
        amountCents,
        // The invoice's own currency wins - it is validated at creation.
        // Falling back to the workspace default charged an EUR invoice's
        // numeric total in USD.
        currency: (inv.currency || settings?.currency || 'USD').toUpperCase(),
        description: `Invoice ${inv.number}`,
        metadata: { invoice_id: inv.id, invoice_number: inv.number, workspace_id: inv.workspace_id },
        successUrl,
        cancelUrl,
        customerEmail: inv.client_email || undefined,
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

    return ok(res, { url: session.url });
  } catch (err) {
    return serverError(res, err);
  }
}
