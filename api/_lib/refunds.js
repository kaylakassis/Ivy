// Shared refund core. Extracted from api/invoices/refund.js so BOTH the
// HTTP route and Ivy's refund_invoice tool run the exact same money logic
// (provider dispatch, partial-amount math, idempotency, concurrency
// guard) instead of duplicating it. Money out of a real account is not a
// place for two slightly-different code paths.
//
// Returns { invoice (serialized), refund: { amount, method, fullyRefunded,
// stripeRefundId, giftRestoredCents, parts } } on success. Throws Error (with a
// user-safe message) on any validation/provider failure - callers map
// that to their own error shape (badRequest for the route; tool error
// surfaced to the owner for Ivy).
//
// `audit` is optional: when { req, actor } is supplied (the HTTP route),
// an immutable workspace-audit row is recorded. Ivy omits it (no request
// object), so the refund itself still happens but the IP-scoped audit
// trail is skipped - the invoice activity log still captures the refund.
import { sql } from './db.js';
import { createRefund } from './stripe.js';
import { loadStripeCreds } from './stripeCreds.js';
import { createRefund as squareCreateRefund } from './payments/square.js';
import { createRefund as paypalCreateRefund } from './payments/paypal.js';
import { fetchOwnedInvoice, serializeInvoice, computeTotals, fetchFinanceSettings } from './finance.js';
import { recordWorkspaceAudit } from './audit.js';
import { notifyInvoiceRefunded } from './invoiceNotify.js';
import { restoreGiftCardCreditForInvoice } from './giftCards.js';
import { ensureInvoiceLedger, allocateRefund, applyRefundToPayment, PROVIDER_REFUNDABLE } from './invoiceLedger.js';

const VALID_REASONS = new Set(['duplicate', 'fraudulent', 'requested_by_customer']);

function fmtMoney(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;

// One in-app refund per invoice at a time. A lease, not a lock: a request
// that dies mid-way frees it after a couple of minutes, and the provider
// idempotency keys (per payment + what that payment had refunded) make the
// retry return the refunds already made instead of sending money twice.
const REFUND_LEASE = '2 minutes';
const BUSY_MESSAGE = 'Another refund on this invoice is still going through. Wait a moment, then check the invoice before trying again.';

// Refund an invoice. The amount is split across the invoice's payments
// newest first (invoice_payments, see invoiceLedger.js), one provider
// refund per payment, never more than each payment has left and never more
// than was paid in all. Money recorded by hand (cash, Venmo...) is only
// recorded as given back; a gift card that paid goes back on the card.
//
// All or nothing from the owner's view: if a later provider refund fails,
// what already went through is recorded (and the client told), nothing
// more is claimed, and the thrown Error says exactly what was refunded and
// what was not (err.partial = { refunded, notRefunded, requested, invoice,
// parts }).
export async function refundInvoice({ workspaceId, id, amount: amountIn, reason: reasonIn, audit = null }) {
  if (!id) throw new Error('id is required');

  const first = await fetchOwnedInvoice({ id, workspaceId });
  if (!first) throw new Error('Invoice not found');
  assertRefundable(first);

  const claim = await sql`
    UPDATE invoices SET refund_started_at = NOW()
     WHERE id = ${id} AND workspace_id = ${workspaceId}
       AND (refund_started_at IS NULL OR refund_started_at < NOW() - ${REFUND_LEASE}::interval)
    RETURNING id
  `;
  if (claim.rows.length === 0) throw new Error(BUSY_MESSAGE);
  try {
    return await refundClaimedInvoice({ workspaceId, id, amountIn, reasonIn, audit });
  } finally {
    await sql`UPDATE invoices SET refund_started_at = NULL WHERE id = ${id} AND workspace_id = ${workspaceId}`.catch(() => {});
  }
}

// Paid invoices, and open ones with a part payment on them (the owner
// refunds the part payment, then voids). Anything else has no money to
// give back; the message says what to do instead.
function assertRefundable(inv) {
  const openWithPayment = (inv.status === 'sent' || inv.status === 'overdue') && Number(inv.paid_amount || 0) > 0;
  if (inv.status !== 'paid' && inv.status !== 'refunded' && !openWithPayment) {
    if (inv.status === 'voided') throw new Error('This invoice is void and has no payment to refund.');
    throw new Error(inv.status === 'draft'
      ? 'Nothing has been paid on this invoice, so there is nothing to refund. You can delete the draft.'
      : 'Nothing has been paid on this invoice, so there is nothing to refund. Void it instead.');
  }
  return openWithPayment;
}

async function refundClaimedInvoice({ workspaceId, id, amountIn, reasonIn, audit }) {
  // Re-read under the claim: a refund that finished a moment ago counts.
  const inv = await fetchOwnedInvoice({ id, workspaceId });
  if (!inv) throw new Error('Invoice not found');
  const openWithPayment = assertRefundable(inv);

  const totals = computeTotals(inv.items, inv.tax_rate, inv.discount);
  // Cap refunds against what was ACTUALLY collected (paid_amount), not the
  // recomputed invoice total. With Stripe Tax, paid_amount can exceed the
  // base total (so the tax portion must be refundable); for legacy rows with
  // no paid_amount, fall back to the total.
  const refundBasis = inv.paid_amount != null ? Number(inv.paid_amount) : totals.total;
  const alreadyRefunded = Number(inv.refunded_amount || 0);
  const fs = await fetchFinanceSettings(workspaceId).catch(() => null);
  const rows = await ensureInvoiceLedger(inv, { basis: refundBasis, fs });
  const ledgerLeft = round2(rows.reduce((n, r) => n + Math.max(0, Number(r.amount) - Number(r.refunded_amount)), 0));
  // Never more than was paid: the invoice's own total AND what its payments
  // have left must both cover it.
  const remaining = round2(Math.max(0, Math.min(refundBasis - alreadyRefunded, ledgerLeft)));
  if (remaining <= 0) throw new Error('This invoice has already been fully refunded');

  let amount = amountIn == null ? remaining : Number(amountIn);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('amount must be a positive number');
  if (amount > remaining + 0.001) throw new Error(`Cannot refund more than remaining (${fmtMoney(remaining)})`);
  amount = round2(Math.min(amount, remaining));

  const reason = reasonIn && VALID_REASONS.has(reasonIn) ? reasonIn : null;
  // 'gift_card' = the client paid the whole invoice with a gift card: no
  // processor took money, so a refund puts the credit back on the card.
  // (Kept for the response; each part below goes back the way it came.)
  const method = inv.stripe_payment_intent ? 'card' : (inv.paid_method || 'manual');
  const currency = inv.currency || fs?.currency || 'USD';

  const { parts } = allocateRefund(rows, amount);
  const done = [];
  let failure = null;
  for (const part of parts) {
    const row = part.row;
    const before = Number(row.refunded_amount);
    if (PROVIDER_REFUNDABLE.has(row.provider)) {
      if (!row.provider_payment_id) {
        failure = new Error('An older payment on this invoice was recorded without its payment reference, so it cannot be refunded here. Refund it from your payment dashboard.');
        break;
      }
      let out;
      try {
        // Deterministic per (invoice, payment, what that payment had
        // refunded): a retry gets the original refund back from the
        // provider instead of a second one.
        // eslint-disable-next-line no-await-in-loop
        out = await refundThroughProvider({
          workspaceId, provider: row.provider, paymentIntent: row.provider_payment_id, paidMethod: inv.paid_method,
          amountCents: Math.round(part.amount * 100), currency: row.currency || currency, settings: fs, reason,
          idempotencyKey: `refund-${id}-${row.id}-${Math.round(before * 100)}`,
        });
      } catch (err) {
        failure = err;
        break;
      }
      // Answered, but refused (Square FAILED / REJECTED, PayPal FAILED /
      // CANCELLED): no money moved, so nothing is recorded.
      if (['failed', 'rejected', 'canceled', 'cancelled', 'denied'].includes(String(out?.status || '').toLowerCase())) {
        const who = row.provider === 'square' ? 'Square' : row.provider === 'paypal' ? 'PayPal' : 'the payment processor';
        failure = new Error(`The refund did not go through at ${who} (status ${String(out.status).toUpperCase()}). No money was returned for that payment.`);
        break;
      }
      // Stripe reports refunds as a running total per payment (the
      // charge.refunded echo carries it), so the row moves UP to it; Square
      // and PayPal report each refund by id, so the id makes it count once
      // whichever of this write and their webhook lands first.
      // eslint-disable-next-line no-await-in-loop
      const applied = row.provider === 'stripe'
        ? await applyRefundToPayment({ workspaceId, paymentRowId: row.id, cumulative: before + part.amount, refundId: out?.id || null })
        : await applyRefundToPayment({ workspaceId, paymentRowId: row.id, add: part.amount, refundId: out?.id || null });
      done.push({ row, amount: part.amount, providerRefundId: out?.id || null, delta: applied.delta });
    } else {
      // Cash / Venmo / a gift card: nothing to send through a processor.
      // eslint-disable-next-line no-await-in-loop
      const applied = await applyRefundToPayment({ workspaceId, paymentRowId: row.id, add: part.amount, expectBefore: before });
      if (applied.delta <= 0) {
        failure = new Error('This invoice changed while the refund was being recorded. Check it and try again.');
        break;
      }
      done.push({ row, amount: part.amount, providerRefundId: null, delta: applied.delta });
    }
  }

  const refunded = round2(done.reduce((n, d) => n + d.amount, 0));
  if (refunded <= 0) throw failure || new Error('Refund failed');
  const appliedHere = round2(done.reduce((n, d) => n + d.delta, 0));
  const stripeRefundId = done.find((d) => d.providerRefundId)?.providerRefundId || null;
  const refundIds = done.map((d) => d.providerRefundId).filter(Boolean);
  const partsOut = done.map((d) => ({
    provider: d.row.provider, providerPaymentId: d.row.provider_payment_id || null,
    providerRefundId: d.providerRefundId, amount: d.amount,
  }));

  let current = await fetchOwnedInvoice({ id, workspaceId });
  const fullyRefunded = Number(current?.refunded_amount || 0) >= refundBasis - 0.001;

  // One activity line for the whole refund (a webhook that reported these
  // same refunds first already wrote its own line, then appliedHere is 0).
  if (appliedHere > 0) {
    const anyCard = done.some((d) => PROVIDER_REFUNDABLE.has(d.row.provider));
    const allGift = done.every((d) => d.row.provider === 'gift_card');
    const activityEntry = {
      ts: new Date().toISOString(),
      kind: 'refund',
      text: `Refunded ${fmtMoney(refunded)}${anyCard ? ' to card' : allGift ? ' to the gift card' : ''}${reason ? ` (${reason.replace(/_/g, ' ')})` : ''}`,
      ...(stripeRefundId ? { stripeRefundId } : {}),
      ...(refundIds.length > 1 ? { refundIds } : {}),
    };
    await sql`
      UPDATE invoices SET activity = COALESCE(activity, '[]'::jsonb) || ${JSON.stringify([activityEntry])}::jsonb, updated_at = NOW()
       WHERE id = ${id} AND workspace_id = ${workspaceId}
    `;
  }

  // Immutable trail - only when an HTTP request context is supplied.
  if (audit?.req) {
    recordWorkspaceAudit(audit.req, {
      workspaceId, actor: audit.actor,
      action: 'invoice.refund',
      target: { kind: 'invoice', id: inv.id },
      meta: {
        number: inv.number, amount: refunded, requested_amount: amount, method, reason: reason || null,
        provider_refund_id: stripeRefundId || null, provider_refund_ids: refundIds, fully_refunded: fullyRefunded,
        ...(failure ? { not_refunded: round2(amount - refunded) } : {}),
      },
    });
  }

  // Gift card credit goes back on the card: a gift card that paid (its own
  // ledger row) gets back what was refunded from it; for a mixed invoice
  // (card + processor), the credit comes back once the money part is fully
  // refunded. Exactly-once inside the helper; a failure is logged and the
  // credit stays claimable for a later void / refund.
  let giftRestoredCents = 0;
  const giftPartCents = Math.round(done.filter((d) => d.row.provider === 'gift_card').reduce((n, d) => n + d.amount, 0) * 100);
  const restore = (amountCents) => restoreGiftCardCreditForInvoice({ workspaceId, invoiceId: inv.id, amountCents })
    .catch((err) => { console.error('[refund] gift card restore failed:', err.message); return 0; });
  if (giftPartCents > 0) giftRestoredCents += await restore(giftPartCents);
  const giftLeft = Number(inv.gift_card_credit_cents || 0) - Number(inv.gift_card_credit_restored_cents || 0) - giftRestoredCents;
  if (giftLeft > 0 && !openWithPayment && fullyRefunded) giftRestoredCents += await restore(null);

  // Tell the client, for what this request recorded. Never let an email
  // failure undo or fail a refund that already moved money.
  if (appliedHere > 0) {
    await notifyInvoiceRefunded({
      workspaceId, invoiceId: inv.id, amount: refunded,
      method: inv.stripe_payment_intent ? (inv.paid_method === 'ach' ? 'ach' : 'card') : (inv.paid_method || 'other'),
      giftRestoredCents,
    }).catch(() => {});
  }

  current = (await fetchOwnedInvoice({ id, workspaceId })) || current;
  const invoice = serializeInvoice(current);
  if (failure) {
    const notRefunded = round2(amount - refunded);
    const err = new Error(`Only ${fmtMoney(refunded)} of the ${fmtMoney(amount)} refund went through. The other ${fmtMoney(notRefunded)} was not refunded: ${failure.message}`);
    err.partial = { refunded, notRefunded, requested: amount, invoice, parts: partsOut };
    throw err;
  }
  return {
    invoice,
    refund: { amount: refunded, method, fullyRefunded, stripeRefundId, giftRestoredCents, parts: partsOut },
  };
}

// Send `amountCents` back through the provider that CAPTURED the payment,
// not whatever provider is currently selected - owners who switch
// providers must still be able to refund older sales. Each capture path
// leaves a distinct signature: PayPal stamps paid_method='paypal'; Stripe
// payment ids are pi_/ch_-prefixed; Square ids are neither. Shared by the
// invoice refund above and the purchase refunds (programs, gift cards,
// packages) in purchaseRefunds.js, so money leaves through one code path.
// `idempotencyKey` must be deterministic per (purchase, cumulative amount)
// so a retry returns the original refund instead of issuing a second one.
//
// `provider` (when the caller knows it, e.g. from the invoice's payment
// ledger) skips the guess. `currency` is the currency the payment was
// taken in (an invoice's own currency); the workspace currency is only the
// fallback for a purchase that records none.
export async function refundThroughProvider({ workspaceId, paymentIntent, paidMethod = null, provider: providerIn = null, currency = null, settings = null, amountCents, reason = null, idempotencyKey }) {
  if (!paymentIntent) throw new Error('No online payment is attached to this purchase');
  const fs = settings || await fetchFinanceSettings(workspaceId);
  const provider = providerIn && ['stripe', 'square', 'paypal'].includes(providerIn) ? providerIn
    : paidMethod === 'paypal' ? 'paypal'
    : /^(pi_|ch_)/.test(paymentIntent) ? 'stripe'
    : (fs?.paymentProvider === 'square' || paidMethod === 'card') ? 'square'
    : (fs?.paymentProvider || 'stripe');
  const refundCurrency = String(currency || fs?.currency || 'USD').toUpperCase();
  if (provider === 'square') {
    return squareCreateRefund({
      workspaceId, settings: fs, paymentIntent, amountCents, currency: refundCurrency, reason, idempotencyKey,
    });
  }
  if (provider === 'paypal') {
    return paypalCreateRefund({
      workspaceId, settings: fs, paymentIntent, amountCents, currency: refundCurrency, reason, idempotencyKey,
    });
  }
  let creds;
  try {
    creds = await loadStripeCreds(workspaceId);
  } catch (err) {
    if (err.code === 'no_stripe_connection') {
      throw new Error('Card refund needs your Stripe account connected. Reconnect Stripe in Finance, or refund manually.');
    }
    throw err;
  }
  return createRefund({
    secretKey: creds.secretKey, stripeAccount: creds.stripeAccount,
    paymentIntent, amountCents, reason, idempotencyKey,
  });
}
