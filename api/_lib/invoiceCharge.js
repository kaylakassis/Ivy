// Off-session charge of a client's saved card for an invoice.
// Used by:
//   • api/pos/sale.js — in-person card-on-file sale
//   • api/cron/recurring-invoices.js — auto-charge recurring schedules
//
// On success the invoice is marked paid in the same shape the
// checkout-completed webhooks would write: status='paid', paid_at,
// paid_amount, stripe_payment_intent, view_token_hash cleared, paid
// activity entry appended. So downstream code (revenue queries,
// receipt emails, refund flow) treats these the same as any other
// paid invoice.
//
// On failure the charge attempt is recorded as an activity entry on
// the invoice but the status stays unchanged, so the owner sees the
// retry signal in the audit log and the client can still pay via
// the regular pay-link path.
//
// Idempotency: idempotencyKey = `inv-charge-${invoiceId}`. A retry
// (Vercel cold start, cron re-run, double-click) reuses Stripe's
// original charge instead of double-billing. The DB UPDATE has
// `WHERE status <> 'paid'` so a second successful attempt doesn't
// double-stamp the invoice.
import { sql } from './db.js';
import { computeTotals } from './finance.js';
import { loadStripeCreds } from './stripeCreds.js';
import { chargeOffSession } from './stripe.js';

function fmtMoney(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Result shape: `{ ok: boolean, code, message?, invoice?, paymentIntent?, chargeAmount? }`
// Codes:
//   ok=true,  code='charged'          — invoice was charged + marked paid
//   ok=true,  code='already-paid'     — invoice was already paid; no-op
//   ok=false, code='invoice-not-found'
//   ok=false, code='no-client'
//   ok=false, code='no-card-on-file'
//   ok=false, code='zero-amount'
//   ok=false, code='no_stripe_connection' | 'platform_secret_missing' | 'stripe_credentials_invalid'
//   ok=false, code='charge-failed'    — Stripe declined (declined, 3DS required, etc.)
export async function chargeInvoiceOffSession({ invoiceId, workspaceId }) {
  const r = await sql`
    SELECT inv.*,
           c.stripe_customer_id, c.payment_method_id
      FROM invoices inv
      LEFT JOIN clients c
        ON c.id = inv.client_id AND c.workspace_id = inv.workspace_id
     WHERE inv.id = ${invoiceId} AND inv.workspace_id = ${workspaceId}
     LIMIT 1
  `;
  const inv = r.rows[0];
  if (!inv) return { ok: false, code: 'invoice-not-found' };
  if (inv.status === 'paid') return { ok: true, code: 'already-paid', invoice: inv };
  if (!inv.client_id) {
    return { ok: false, code: 'no-client', message: 'Invoice has no client linked' };
  }
  if (!inv.stripe_customer_id || !inv.payment_method_id) {
    return { ok: false, code: 'no-card-on-file', message: 'Client has no card on file' };
  }

  const totals = computeTotals(inv.items || [], inv.tax_rate, inv.discount);
  if (!(totals.total > 0)) {
    return { ok: false, code: 'zero-amount', message: 'Nothing to charge' };
  }

  let creds;
  try { creds = await loadStripeCreds(workspaceId); }
  catch (err) {
    return { ok: false, code: err.code || 'stripe-creds-failed', message: err.message };
  }

  let pi;
  try {
    pi = await chargeOffSession({
      secretKey: creds.secretKey,
      stripeAccount: creds.stripeAccount,
      customerId: inv.stripe_customer_id,
      paymentMethodId: inv.payment_method_id,
      amountCents: Math.round(totals.total * 100),
      currency: (inv.currency || creds.currency || 'USD'),
      description: `Invoice ${inv.number}`,
      metadata: { invoice_id: inv.id, workspace_id: workspaceId },
      statementDescriptor: `INV ${inv.number}`,
      idempotencyKey: `inv-charge-${inv.id}`,
    });
  } catch (err) {
    // Decline / authentication_required / etc. Record on the invoice
    // so the owner sees an audit trail of the attempt.
    const failActivity = [
      ...(inv.activity || []),
      {
        ts: new Date().toISOString(),
        kind: 'charge-failed',
        text: `Auto-charge failed: ${err.message || 'card declined'}`,
      },
    ];
    await sql`
      UPDATE invoices SET
        activity = ${JSON.stringify(failActivity)}::jsonb,
        updated_at = NOW()
      WHERE id = ${inv.id} AND workspace_id = ${workspaceId}
    `;
    return { ok: false, code: 'charge-failed', message: err.message || 'Card declined' };
  }

  // Stripe authoritative amount (in the currency's smallest unit).
  // amount_received is the captured amount; amount is the requested.
  // They should equal for a successful off-session charge, but
  // preferring amount_received protects against partial-capture edges.
  const stripeAmountCents = Number(pi.amount_received ?? pi.amount);
  const collectedAmount = Number.isFinite(stripeAmountCents) && stripeAmountCents > 0
    ? Math.round(stripeAmountCents) / 100
    : totals.total;

  const newActivity = [
    ...(inv.activity || []),
    {
      ts: new Date().toISOString(),
      kind: 'paid',
      text: `Paid by card on file · ${fmtMoney(collectedAmount)}`,
    },
  ];

  const upd = await sql`
    UPDATE invoices SET
      status = 'paid',
      paid_at = NOW(),
      paid_method = 'card',
      paid_amount = ${collectedAmount},
      stripe_payment_intent = ${pi.id},
      view_token_hash = NULL,
      activity = ${JSON.stringify(newActivity)}::jsonb,
      updated_at = NOW()
    WHERE id = ${inv.id} AND workspace_id = ${workspaceId} AND status <> 'paid'
    RETURNING *
  `;

  return {
    ok: true,
    code: 'charged',
    invoice: upd.rows[0] || inv,
    paymentIntent: pi,
    chargeAmount: collectedAmount,
  };
}
