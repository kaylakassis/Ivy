// Canonical "mark an invoice paid from a card checkout" + a Stripe
// self-heal reconcile. Used by the synchronous return-confirm path and the
// public-invoice self-heal so a payment lands in the finance tab WITHOUT
// depending on the per-workspace Stripe webhook (which most owners never
// configure - Express/Connect owners can't). Idempotent and side-effect-safe.
import { sql } from './db.js';
import { computeTotals, paidMethodLabel } from './finance.js';
import { notifyOwnerSafe, notifyClientSafe } from './push.js';
import { notifyInvoicePaid } from './invoiceNotify.js';
import { loadStripeCreds } from './stripeCreds.js';
import { fetchCheckoutSession, expireCheckoutSession } from './stripe.js';

function fmtMoney(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Where a payment leaves an invoice. paid_amount on a still-open invoice
// is the running total of part payments so far (the pay link already
// charges only what is left), so a new payment ADDS to it, and the
// invoice is settled once that running total covers what is due after
// any gift card. `seen` = this payment id is already in the running total
// (the paired Checkout + PaymentIntent events, a webhook retry, the PayPal
// return page racing its webhook) and must not be added again.
// Shared by the Stripe, Square and PayPal apply paths.
export function invoicePaymentState(inv, { paymentId = null, amountCents = null } = {}) {
  const totals = computeTotals(inv.items || [], inv.tax_rate, inv.discount);
  const giftCredit = Number(inv.gift_card_credit_cents || 0) / 100;
  const due = Math.max(0, Math.round((totals.total - giftCredit) * 100) / 100);
  const open = ['draft', 'sent', 'overdue'].includes(inv.status);
  const prior = open ? Math.max(0, Math.round(Number(inv.paid_amount || 0) * 100) / 100) : 0;
  const seen = !!paymentId && prior > 0 && (
    inv.stripe_payment_intent === paymentId
    || (inv.activity || []).some((a) => a?.kind === 'partial-payment' && a.paymentId === paymentId));
  const thisPayment = amountCents != null ? Math.round(Number(amountCents)) / 100 : null;
  const paidTotal = thisPayment == null ? Math.max(due, prior) : Math.round((prior + thisPayment) * 100) / 100;
  return { totals, due, prior, seen, thisPayment, paidTotal, underpaid: thisPayment != null && paidTotal < due - 0.01 };
}

// Idempotent. Marks the invoice paid (status, paid fields, activity) and,
// only when it actually transitions, fires the owner push + client receipt
// - matching the webhook so whichever path wins first is the one that
// notifies. Returns 'paid' | 'partial-payment' | 'already-paid' | 'invoice-not-found'.
export async function markInvoicePaid({ workspaceId, invoiceId, paymentIntent, amountCents, method = 'card', sessionId = null, _attempt = 0 }) {
  const { rows } = await sql`SELECT * FROM invoices WHERE id = ${invoiceId} AND workspace_id = ${workspaceId}`;
  const inv = rows[0];
  if (!inv) return 'invoice-not-found';
  if (inv.status === 'paid' || inv.status === 'refunded') return 'already-paid';
  const retry = () => markInvoicePaid({ workspaceId, invoiceId, paymentIntent, amountCents, method, sessionId, _attempt: _attempt + 1 });

  // A gift card applied on the public pay page already covers part of the
  // total, so a card payment only has to cover the remainder (and a
  // 'gift_card' payment is the credit itself covering everything). Part
  // payments already recorded count toward it too.
  const giftOnly = method === 'gift_card';
  const st = invoicePaymentState(inv, { paymentId: paymentIntent, amountCents: giftOnly ? null : amountCents });
  // This exact payment is already in the running total.
  if (st.seen) return 'partial-payment';
  const dueAfterCredit = st.due;
  // A gift card that covers the rest after a part payment keeps that
  // payment on record (amount, method, payment id) so a refund goes back
  // through the processor that took it; the credit has its own column.
  const keepPrior = giftOnly && st.prior > 0;
  const paidAmount = giftOnly
    ? (keepPrior ? st.prior : (amountCents != null ? Math.round(Number(amountCents)) / 100 : dueAfterCredit))
    : st.paidTotal;
  const paidMethod = keepPrior ? (inv.paid_method || 'card') : method;
  const paidIntent = keepPrior ? (inv.stripe_payment_intent || null) : (paymentIntent || null);

  // Guard against an UNDER-payment flipping the invoice to fully paid (e.g. the
  // invoice amount was edited up after the Checkout session was created for the
  // old, lower amount). Mirror the Square/PayPal apply paths: record the
  // partial payment but leave the invoice open. Stripe-Tax can make the charged
  // amount EXCEED the base total — that's expected, so only under-payment is a
  // problem (1¢ tolerance for rounding).
  if (!giftOnly && st.underpaid) {
    const partialActivity = [
      ...(inv.activity || []),
      { ts: new Date().toISOString(), kind: 'partial-payment', paymentId: paymentIntent || null,
        text: `Partial card payment · ${fmtMoney(st.thisPayment)} · ${fmtMoney(paidAmount)} of ${fmtMoney(dueAfterCredit)} paid` },
    ];
    // Guarded on the running total we read, so a second payment landing at
    // the same moment re-reads and adds on top instead of overwriting.
    const part = await sql`
      UPDATE invoices SET
        paid_amount           = ${paidAmount},
        paid_method           = ${method},
        stripe_payment_intent = ${paymentIntent || null},
        stripe_session_id     = COALESCE(${sessionId}, stripe_session_id),
        payment_processing_at = NULL,
        payment_processing_method = NULL,
        activity              = ${JSON.stringify(partialActivity)}::jsonb,
        updated_at            = NOW()
      WHERE id = ${invoiceId} AND workspace_id = ${workspaceId} AND status IN ('draft', 'sent', 'overdue')
        AND COALESCE(paid_amount, 0) = ${st.prior}
      RETURNING id
    `;
    if (part.rows.length === 0 && _attempt < 3) return retry();
    return 'partial-payment';
  }

  const newActivity = [
    ...(inv.activity || []),
    { ts: new Date().toISOString(), kind: 'paid',
      text: `Paid by ${paidMethodLabel(method)} · ${fmtMoney(giftOnly || st.prior === 0 ? paidAmount : st.thisPayment)}${!giftOnly && st.prior > 0 ? ` · ${fmtMoney(paidAmount)} in total` : ''}` },
  ];

  const upd = await sql`
    UPDATE invoices SET
      status                = 'paid',
      paid_at               = NOW(),
      paid_amount           = ${paidAmount},
      paid_method           = ${paidMethod},
      stripe_payment_intent = ${paidIntent},
      stripe_session_id     = COALESCE(${sessionId}, stripe_session_id),
      payment_processing_at = NULL,
      payment_processing_method = NULL,
      view_token_hash       = NULL,
      activity              = ${JSON.stringify(newActivity)}::jsonb,
      updated_at            = NOW()
    WHERE id = ${invoiceId} AND workspace_id = ${workspaceId} AND status <> 'paid'
      AND COALESCE(paid_amount, 0) = COALESCE(${inv.paid_amount}::numeric, 0)
    RETURNING id
  `;
  if (upd.rows.length === 0) {
    // Lost a race: the webhook / another confirm already settled it, or a
    // part payment landed in between (then this one counts on top of it).
    const now = (await sql`SELECT status FROM invoices WHERE id = ${invoiceId} AND workspace_id = ${workspaceId}`).rows[0];
    if (now && now.status !== 'paid' && now.status !== 'refunded' && _attempt < 3) return retry();
    return 'already-paid';
  }

  // Autopay charges say so (and with which card), so the owner can tell
  // a hands-off payment from one the client made.
  const autopaid = ['charging', 'succeeded', 'processing'].includes(inv.autopay_status) && inv.autopay_card_last4;
  notifyOwnerSafe({
    workspaceId, type: 'payments',
    payload: {
      title: autopaid ? 'Autopay collected' : 'Invoice paid 💸',
      body: `${inv.client_name || 'A client'} · ${inv.number} · ${fmtMoney(paidAmount)}${autopaid ? ` · ${String(inv.autopay_card_brand || 'card').replace(/^./, (c) => c.toUpperCase())} ${inv.autopay_card_last4}` : ''}`,
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

// A Stripe checkout opened earlier for this invoice (another tab, another
// device, the email link clicked twice) stays payable until it is closed,
// so the client could pay the same invoice twice, or pay the full amount
// after a gift card already covered part of it. Call before a new payment
// can start. Returns 'paid' (that checkout was paid a moment ago; the
// invoice is now settled), 'processing' (a bank debit from it is on its
// way), 'closed' or 'none'.
export async function settleOrCloseOpenCheckout(inv) {
  const sid = inv?.stripe_session_id;
  if (!sid || !String(sid).startsWith('cs_')) return 'none';
  if (await reconcileStripeInvoice(inv).catch(() => false)) return 'paid';
  const fresh = await sql`SELECT payment_processing_at FROM invoices WHERE id = ${inv.id} AND workspace_id = ${inv.workspace_id}`;
  if (fresh.rows[0]?.payment_processing_at) return 'processing';
  await expireStripeCheckout(inv.workspace_id, sid);
  return 'closed';
}

// Close one Stripe checkout on the workspace's account. Best effort: one
// that already finished or expired is fine to leave alone.
export async function expireStripeCheckout(workspaceId, sessionId) {
  try {
    const creds = await loadStripeCreds(workspaceId);
    await expireCheckoutSession({ secretKey: creds.secretKey, stripeAccount: creds.stripeAccount, sessionId });
  } catch { /* already complete / expired, or not reachable */ }
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
  if (session?.payment_status !== 'paid') {
    // A completed session that is still 'unpaid' is a delayed method (ACH
    // Direct Debit): the debit was authorised but settles days later. Stamp
    // "payment processing" so neither side treats it as paid or missing.
    if (session?.status === 'complete' && session?.payment_status === 'unpaid') {
      const { markInvoiceProcessing } = await import('./checkoutFulfillment.js');
      await markInvoiceProcessing({ workspaceId: inv.workspace_id, invoiceId: inv.id, session });
    }
    return false;
  }

  const { fulfillInvoiceCheckoutSession } = await import('./checkoutFulfillment.js');
  const r = await fulfillInvoiceCheckoutSession({ workspaceId: inv.workspace_id, session, creds });
  return r === 'paid' || r === 'already-paid';
}
