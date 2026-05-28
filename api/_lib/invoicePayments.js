// Canonical "mark an invoice paid from a card checkout" + a Stripe
// self-heal reconcile. Used by the synchronous return-confirm path and the
// public-invoice self-heal so a payment lands in the finance tab WITHOUT
// depending on the per-workspace Stripe webhook (which most owners never
// configure — Express/Connect owners can't). Idempotent and side-effect-safe.
import { sql } from './db.js';
import { computeTotals } from './finance.js';
import { notifyOwnerSafe, notifyClientSafe } from './push.js';
import { notifyInvoicePaid } from './invoiceNotify.js';
import { loadStripeCreds } from './stripeCreds.js';
import { fetchCheckoutSession } from './stripe.js';

function fmtMoney(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Idempotent. Marks the invoice paid (status, paid fields, activity) and,
// only when it actually transitions, fires the owner push + client receipt
// — matching the webhook so whichever path wins first is the one that
// notifies. Returns 'paid' | 'already-paid' | 'invoice-not-found'.
export async function markInvoicePaid({ workspaceId, invoiceId, paymentIntent, amountCents, method = 'card' }) {
  const { rows } = await sql`SELECT * FROM invoices WHERE id = ${invoiceId} AND workspace_id = ${workspaceId}`;
  const inv = rows[0];
  if (!inv) return 'invoice-not-found';
  if (inv.status === 'paid' || inv.status === 'refunded') return 'already-paid';

  const totals = computeTotals(inv.items || [], inv.tax_rate, inv.discount);
  const paidAmount = amountCents != null ? Math.round(Number(amountCents)) / 100 : totals.total;
  const newActivity = [
    ...(inv.activity || []),
    { ts: new Date().toISOString(), kind: 'paid', text: `Paid by card · ${fmtMoney(paidAmount)}` },
  ];

  const upd = await sql`
    UPDATE invoices SET
      status                = 'paid',
      paid_at               = NOW(),
      paid_amount           = ${paidAmount},
      paid_method           = ${method},
      stripe_payment_intent = ${paymentIntent || null},
      view_token_hash       = NULL,
      activity              = ${JSON.stringify(newActivity)}::jsonb,
      updated_at            = NOW()
    WHERE id = ${invoiceId} AND workspace_id = ${workspaceId} AND status <> 'paid'
    RETURNING id
  `;
  if (upd.rows.length === 0) return 'already-paid'; // lost a race with the webhook / another confirm

  notifyOwnerSafe({
    workspaceId, type: 'payments',
    payload: {
      title: 'Invoice paid 💸',
      body: `${inv.client_name || 'A client'} · ${inv.number} · ${fmtMoney(paidAmount)}`,
      url: `/finance?invoice=${invoiceId}`,
      tag: `invoice-paid-${invoiceId}`,
    },
  });
  // Client receipt push (in addition to the email). Email may sit
  // unread for hours; clients want the moment-of-charge confirmation.
  if (inv.client_id) {
    notifyClientSafe({
      clientId: inv.client_id,
      type: 'payments',
      payload: {
        title: 'Payment received',
        body: `${inv.number} · ${fmtMoney(paidAmount)} paid. Thanks!`,
        url: '/me/invoices',
        tag: `invoice-paid-client-${invoiceId}`,
      },
    });
  }
  notifyInvoicePaid({ workspaceId, invoiceId, totalAmount: paidAmount, method });
  return 'paid';
}

// Stripe-only self-heal: if an unpaid invoice carries a Stripe checkout
// session that actually completed, mark it paid now. No-op for non-Stripe
// sessions (cs_ prefix gate), unpaid sessions, or missing creds. Returns
// true if the invoice is (now) paid.
export async function reconcileStripeInvoice(inv) {
  if (!inv) return false;
  if (inv.status === 'paid' || inv.status === 'refunded') return true;
  const sid = inv.stripe_session_id;
  if (!sid || !String(sid).startsWith('cs_')) return false; // Stripe Checkout ids start with cs_

  let creds;
  try { creds = await loadStripeCreds(inv.workspace_id); } catch { return false; }
  let session;
  try {
    session = await fetchCheckoutSession({ secretKey: creds.secretKey, stripeAccount: creds.stripeAccount, sessionId: sid });
  } catch { return false; }
  if (session?.payment_status !== 'paid') return false;

  const paymentIntent = typeof session.payment_intent === 'string'
    ? session.payment_intent : session.payment_intent?.id || null;
  const r = await markInvoicePaid({
    workspaceId: inv.workspace_id, invoiceId: inv.id,
    paymentIntent, amountCents: session.amount_total,
  });
  return r === 'paid' || r === 'already-paid';
}
