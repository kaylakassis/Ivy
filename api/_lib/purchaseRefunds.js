// In-app refunds for purchases that have no invoice row: one-time program
// purchases, gift cards and packages bought from the public pages. The
// invoice counterpart is refundInvoice in refunds.js; this file gives the
// other three the same guarantees:
//
//   • money leaves through the provider that took the payment
//     (refundThroughProvider, shared with invoices), with a deterministic
//     idempotency key per purchase + cumulative amount so a retry or a
//     double click returns the original refund instead of a second one;
//   • full or partial amounts, never more than what is left (the route
//     maps the Error to a 400);
//   • concurrency-safe: the state change is a guarded UPDATE on the
//     purchase row's cumulative refunded_cents, so two racing requests
//     apply once and the loser reports deduped;
//   • the SAME state changes the payment-dashboard path applies, because
//     it literally runs that path: syncRefundToPurchases (gift card voided
//     or trimmed, package cancelled on a full refund) and
//     revokeProgramPurchaseForRefund (enrollment closed on a full refund)
//     are handed a synthetic charge with the new cumulative amount. The
//     later charge.refunded echo from the provider then compares equal
//     and is a no-op, so nothing is applied twice;
//   • the owner is told (push, inside those helpers), the client gets a
//     "Refund issued" email (purchaseRefundNotify.js, also inside those
//     helpers), and the owner's audit trail gets a row.
//
// Memberships are NOT handled here on purpose: they are provider
// subscriptions billed on a cycle, and a refund of one invoice period is
// made against that period's charge from the payment dashboard, where the
// subscription itself can be cancelled or credited in the same place.
// Programs sold as subscriptions are refused for the same reason.
import { sql } from './db.js';
import { refundThroughProvider } from './refunds.js';
import { syncRefundToPurchases } from './checkoutFulfillment.js';
import { revokeProgramPurchaseForRefund, isUuid } from './programs.js';
import { recordWorkspaceAudit } from './audit.js';

export const REFUNDABLE_KINDS = new Set(['program', 'gift_card', 'package']);
const VALID_REASONS = new Set(['duplicate', 'fraudulent', 'requested_by_customer']);

function fmtMoney(cents) {
  return '$' + (Number(cents || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Load the purchase row the owner wants to refund, always scoped by
// workspace. Returns { row, basisCents, refundedCents, paymentIntent, label }
// or null when nothing matches.
async function loadPurchase({ kind, id, workspaceId }) {
  if (kind === 'program') {
    const r = await sql`
      SELECT e.*, p.title AS program_title FROM program_enrollments e
        JOIN programs p ON p.id = e.program_id
       WHERE e.id = ${id} AND e.workspace_id = ${workspaceId} LIMIT 1`;
    const e = r.rows[0];
    if (!e) return null;
    if (e.billing !== 'one_time' || e.stripe_subscription_id) {
      throw new Error('Only one-time program purchases can be refunded here. A subscription is refunded from your payment dashboard, where it can be cancelled in the same place.');
    }
    // A manual grant (free / paid elsewhere) has no online payment behind it.
    return { row: e, basisCents: Number(e.price_cents || 0), refundedCents: Number(e.refunded_cents || 0),
      paymentIntent: e.source === 'purchase' ? (e.stripe_payment_intent || null) : null, label: e.program_title };
  }
  if (kind === 'gift_card') {
    const r = await sql`SELECT * FROM gift_cards WHERE id = ${id} AND workspace_id = ${workspaceId} LIMIT 1`;
    const c = r.rows[0];
    if (!c) return null;
    return { row: c, basisCents: Number(c.original_amount_cents || 0), refundedCents: Number(c.refunded_cents || 0),
      paymentIntent: c.stripe_payment_intent || null, label: `gift card ending ${c.code_last4}` };
  }
  if (kind === 'package') {
    const r = await sql`SELECT * FROM client_packages WHERE id = ${id} AND workspace_id = ${workspaceId} LIMIT 1`;
    const cp = r.rows[0];
    if (!cp) return null;
    return { row: cp, basisCents: Math.round(Number(cp.price || 0) * 100), refundedCents: Number(cp.refunded_cents || 0),
      paymentIntent: cp.stripe_payment_intent || null, label: cp.name };
  }
  return null;
}

// Returns { refund: { amountCents, fullyRefunded, providerRefundId, deduped? }, label }.
// Throws Error with a message safe to show the owner.
export async function refundPurchase({ workspaceId, kind, id, amountCents: amountIn, reason: reasonIn, audit = null }) {
  if (!REFUNDABLE_KINDS.has(kind)) throw new Error('Unknown purchase type');
  if (!isUuid(id)) throw new Error('Purchase not found');
  const purchase = await loadPurchase({ kind, id, workspaceId });
  if (!purchase) throw new Error('Purchase not found');
  if (!purchase.paymentIntent) {
    throw new Error('This purchase was not paid online through Ivy, so there is nothing to refund here.');
  }
  const remaining = Math.max(0, purchase.basisCents - purchase.refundedCents);
  if (remaining <= 0) throw new Error('This purchase has already been fully refunded');

  let amountCents = amountIn == null || amountIn === '' ? remaining : Math.round(Number(amountIn));
  if (!Number.isFinite(amountCents) || amountCents <= 0) throw new Error('amount must be a positive number');
  if (amountCents > remaining) throw new Error(`Cannot refund more than remaining (${fmtMoney(remaining)})`);
  const reason = reasonIn && VALID_REASONS.has(reasonIn) ? reasonIn : null;

  // Same key for the same (purchase, cumulative-so-far): a racing or
  // retried request reuses it, and the provider hands back the original
  // refund instead of moving money twice.
  const idempotencyKey = `refund-${kind}-${id}-${purchase.refundedCents}`;
  const providerRefund = await refundThroughProvider({
    workspaceId, paymentIntent: purchase.paymentIntent, paidMethod: 'card',
    amountCents, reason, idempotencyKey,
  });

  // Apply the state change through the exact code the webhook runs, with
  // the cumulative amount the provider will later echo back.
  const cumulative = purchase.refundedCents + amountCents;
  const charge = { payment_intent: purchase.paymentIntent, amount: purchase.basisCents, amount_refunded: cumulative, metadata: {} };
  let deduped = false;
  let fullyRefunded = cumulative >= purchase.basisCents;
  if (kind === 'program') {
    const result = await revokeProgramPurchaseForRefund({ workspaceId, charge });
    deduped = result === 'already-recorded' || result === 'already-cancelled';
    if (result === 'not-found') throw new Error('Purchase not found');
  } else {
    const synced = await syncRefundToPurchases({ workspaceId, charge });
    deduped = !!synced.ignored;
    if (!deduped && typeof synced.fully === 'boolean') fullyRefunded = synced.fully;
  }

  if (!deduped && audit?.req) {
    recordWorkspaceAudit(audit.req, {
      workspaceId, actor: audit.actor,
      action: `${kind}.refund`,
      target: { kind, id },
      meta: {
        label: purchase.label, amount_cents: amountCents, cumulative_cents: cumulative, reason,
        provider_refund_id: providerRefund?.id || null, fully_refunded: fullyRefunded,
      },
    });
  }

  return {
    refund: { amountCents, fullyRefunded, providerRefundId: providerRefund?.id || null, ...(deduped ? { deduped: true } : {}) },
    label: purchase.label,
  };
}
