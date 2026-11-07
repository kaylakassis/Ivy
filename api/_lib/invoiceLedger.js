// Per-payment ledger for invoices (table invoice_payments).
//
// invoices.paid_amount is the running total of every payment on an
// invoice; invoice_payments keeps each payment as its own row, written in
// the SAME statement that moves the running total (see the payment apply
// paths: invoicePayments.js, paypalApply.js, the Square webhook, Mark
// paid, Ivy's mark paid, the POS cash sale). That lets a refund go back to
// the payment that took the money, one provider refund per payment, and
// lets a refund made in a payment dashboard against ANY payment on the
// invoice find its row (it used to match only the latest payment id).
//
// Invariant: the rows of an invoice add up to its paid_amount (a duplicate
// payment on an already-settled invoice is NOT on the ledger: it is not
// in paid_amount either, and the owner is told to refund it from the
// dashboard). Invoices paid before the ledger get one marked
// ("backfilled") row, from the schema backfill or, for anything it missed,
// from ensureInvoiceLedger at refund time.
import { sql } from './db.js';
import { fetchFinanceSettings } from './finance.js';

export const PROVIDER_REFUNDABLE = new Set(['stripe', 'square', 'paypal']);

const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;

// Which provider took a payment recorded only on the invoice row. The same
// reading the refund path always used: PayPal stamps paid_method='paypal';
// Stripe ids are pi_/ch_; any other id is Square; no id is money the owner
// recorded by hand (or a gift card that covered it all). Mirrored in SQL
// by the backfill statement at the end of schema.js.
export function legacyProvider(inv, fs = null) {
  const pid = inv?.stripe_payment_intent || null;
  if (!pid) return inv?.paid_method === 'gift_card' ? 'gift_card' : 'manual';
  if (inv.paid_method === 'paypal') return 'paypal';
  if (/^(pi_|ch_)/.test(pid)) return 'stripe';
  if (fs?.paymentProvider === 'square' || inv.paid_method === 'card') return 'square';
  if (fs?.paymentProvider === 'paypal') return 'paypal';
  return 'stripe';
}

export async function listInvoicePayments({ workspaceId, invoiceId }) {
  const r = await sql`
    SELECT * FROM invoice_payments
     WHERE workspace_id = ${workspaceId} AND invoice_id = ${invoiceId}
     ORDER BY created_at DESC, id DESC
  `;
  return r.rows;
}

// Make sure the ledger covers what the invoice says was paid. `basis` is
// the amount collected (paid_amount, or the total for an old paid row with
// no paid_amount). Adds ONE marked row for any gap, carrying the invoice's
// latest payment id when no row has it yet, and the share of refunds the
// rows do not account for. Safe to call twice at once (one marked row per
// invoice, unique index). Returns the rows, newest first.
export async function ensureInvoiceLedger(inv, { basis = null, fs = null } = {}) {
  const want = round2(basis != null ? basis : (inv.paid_amount != null ? inv.paid_amount : 0));
  let rows = await listInvoicePayments({ workspaceId: inv.workspace_id, invoiceId: inv.id });
  const have = round2(rows.reduce((n, r) => n + Number(r.amount), 0));
  const gap = round2(want - have);
  if (gap <= 0.005) return rows;

  const haveRefunded = round2(rows.reduce((n, r) => n + Number(r.refunded_amount), 0));
  const refunded = Math.min(gap, Math.max(0, round2(Number(inv.refunded_amount || 0) - haveRefunded)));
  const settings = fs || await fetchFinanceSettings(inv.workspace_id).catch(() => null);
  const provider = legacyProvider(inv, settings);
  // The latest payment id, unless a row already holds it (a payment the
  // ledger recorded after this older money came in). Then look for the
  // older payment in the part-payment notes; failing that the row has no
  // id and a refund of it is refused with a plain message rather than sent
  // against the wrong payment.
  const known = new Set(rows.map((r) => r.provider_payment_id).filter(Boolean));
  let pid = inv.stripe_payment_intent || null;
  if (pid && known.has(pid)) {
    const older = [...new Set((inv.activity || [])
      .filter((a) => a?.kind === 'partial-payment' && a.paymentId && !known.has(a.paymentId))
      .map((a) => a.paymentId))];
    pid = older.length === 1 ? older[0] : null;
  }
  const oldest = rows.length ? new Date(Math.min(...rows.map((r) => new Date(r.created_at).getTime())) - 1000) : null;
  const at = [inv.paid_at, inv.sent_at, inv.created_at].map((d) => (d ? new Date(d) : null)).find((d) => d && !Number.isNaN(d.getTime())) || new Date();
  const createdAt = oldest && oldest < at ? oldest : at;

  const insert = (paymentId) => sql`
    INSERT INTO invoice_payments (workspace_id, invoice_id, provider, provider_payment_id, amount, currency, refunded_amount, backfilled, created_at)
    VALUES (${inv.workspace_id}, ${inv.id}, ${provider}, ${paymentId}, ${gap}, ${inv.currency || settings?.currency || null}, ${refunded}, TRUE, ${createdAt})
    ON CONFLICT DO NOTHING
    RETURNING id
  `;
  const ins = await insert(pid);
  // The id belongs to another invoice's row in this business: keep the
  // money on the ledger without it (a refund of this row is then refused).
  if (ins.rows.length === 0 && pid) await insert(null);
  rows = await listInvoicePayments({ workspaceId: inv.workspace_id, invoiceId: inv.id });
  return rows;
}

// Find the ledger row for a provider payment id in a business. An invoice
// paid before the ledger (its latest payment id still on the invoice row)
// gets its marked row written first.
export async function findPaymentRow({ workspaceId, provider, providerPaymentId }) {
  if (!providerPaymentId) return null;
  const q = () => sql`
    SELECT * FROM invoice_payments
     WHERE workspace_id = ${workspaceId} AND provider_payment_id = ${providerPaymentId}
     ORDER BY (provider = ${provider}) DESC, created_at DESC
     LIMIT 1
  `;
  let r = await q();
  if (r.rows[0]) return r.rows[0];
  const inv = (await sql`
    SELECT * FROM invoices
     WHERE workspace_id = ${workspaceId} AND stripe_payment_intent = ${providerPaymentId}
     LIMIT 1
  `).rows[0];
  if (!inv) return null;
  await ensureInvoiceLedger(inv, { basis: inv.paid_amount != null ? inv.paid_amount : (['paid', 'refunded'].includes(inv.status) ? inv.total : 0) });
  r = await q();
  return r.rows[0] || null;
}

// Record a refund against ONE payment row and fold it into the invoice, in
// one statement (so the row and the invoice can never disagree):
//
//   • cumulative: the provider's running refunded total for this payment
//     (Stripe's charge.amount_refunded); the row only ever moves UP to it,
//     so a redelivered event or the echo of a refund the app already
//     recorded adds nothing.
//   • add + refundId: one refund of `add` (Square / PayPal events, and the
//     app's own refunds); refundId is remembered on the row so the same
//     refund reported twice counts once.
//   • add + expectBefore: money given back by hand (no provider id); only
//     applies if the row still has the refunded amount the caller read.
//
// Never past what the payment took. The invoice's refunded_amount moves by
// the same delta; a paid invoice flips to 'refunded' once everything paid
// is back (an open invoice with a part payment stays open). An activity
// line is added only when `activityText` is given ("Refunded $X" + text).
// Returns { delta, invoice } where invoice holds { id, number, status,
// prev_status, refunded_amount, paid_amount } (null when nothing moved).
export async function applyRefundToPayment({
  workspaceId, paymentRowId, cumulative = null, add = null, refundId = null, expectBefore = null,
  activityText = null,
}) {
  const cum = cumulative == null ? null : round2(cumulative);
  const plus = add == null ? null : round2(add);
  const before = expectBefore == null ? null : round2(expectBefore);
  const ts = new Date().toISOString();
  const r = await sql`
    WITH p AS (
      SELECT id, invoice_id, amount, refunded_amount, refund_ids
        FROM invoice_payments
       WHERE id = ${paymentRowId} AND workspace_id = ${workspaceId}
       FOR UPDATE
    ), calc AS (
      SELECT p.id, p.invoice_id, p.refunded_amount AS before_amt,
             LEAST(p.amount,
                   CASE WHEN ${cum}::numeric IS NOT NULL THEN GREATEST(p.refunded_amount, ${cum}::numeric)
                        ELSE p.refunded_amount + COALESCE(${plus}::numeric, 0) END) AS after_amt
        FROM p
       WHERE (${refundId}::text IS NULL OR NOT (${refundId}::text = ANY(p.refund_ids) OR ('failed:' || ${refundId}::text) = ANY(p.refund_ids)))
         AND (${before}::numeric IS NULL OR p.refunded_amount = ${before}::numeric)
    ), upd_p AS (
      UPDATE invoice_payments ip SET
        refunded_amount = calc.after_amt,
        refund_ids      = CASE WHEN ${refundId}::text IS NULL THEN ip.refund_ids ELSE array_append(ip.refund_ids, ${refundId}::text) END,
        updated_at      = NOW()
      FROM calc
      WHERE ip.id = calc.id AND (calc.after_amt > calc.before_amt OR ${refundId}::text IS NOT NULL)
      RETURNING ip.invoice_id, (calc.after_amt - calc.before_amt) AS delta
    ), upd_i AS (
      UPDATE invoices i SET
        refunded_amount = COALESCE(prev.refunded_amount, 0) + upd_p.delta,
        refunded_at     = NOW(),
        status          = CASE
                            WHEN prev.status = 'paid'
                             AND COALESCE(prev.refunded_amount, 0) + upd_p.delta >= COALESCE(prev.paid_amount, prev.total) - 0.005
                            THEN 'refunded'
                            ELSE prev.status
                          END,
        activity        = CASE WHEN ${activityText}::text IS NULL THEN i.activity
                          ELSE COALESCE(i.activity, '[]'::jsonb) || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
                                 'ts', ${ts}::text, 'kind', 'refund',
                                 'text', 'Refunded $' || to_char(upd_p.delta, 'FM999999990.00') || ${activityText}::text,
                                 'stripeRefundId', ${refundId}::text)))
                          END,
        updated_at      = NOW()
      FROM upd_p, invoices prev
      WHERE i.id = upd_p.invoice_id AND prev.id = i.id AND i.workspace_id = ${workspaceId} AND upd_p.delta > 0
      RETURNING i.id, i.number, i.status, prev.status AS prev_status, i.refunded_amount, i.paid_amount, i.client_id
    )
    SELECT (SELECT delta FROM upd_p) AS delta, (SELECT row_to_json(upd_i) FROM upd_i) AS invoice
  `;
  const row = r.rows[0] || {};
  return { delta: round2(row.delta || 0), invoice: row.invoice || null };
}

// A refund the provider later reports as failed (Square FAILED /
// REJECTED): take it back off the payment and the invoice in one
// statement. Only a refund this row counted (its id is in refund_ids)
// moves money back; either way the id is kept as 'failed:<id>' so a late
// "completed" for it is never counted. A refunded invoice that no longer
// has everything back is 'paid' again. Returns { back, invoice } (invoice:
// { id, number, client_name, status, prev_status } or null).
export async function reverseRefundOnPayment({ workspaceId, paymentRowId, refundId, amount, activityText }) {
  const amt = round2(amount);
  const ts = new Date().toISOString();
  const r = await sql`
    WITH p AS (
      SELECT id, invoice_id, refunded_amount, refund_ids
        FROM invoice_payments
       WHERE id = ${paymentRowId} AND workspace_id = ${workspaceId}
       FOR UPDATE
    ), calc AS (
      SELECT p.id, p.invoice_id,
             CASE WHEN ${refundId}::text = ANY(p.refund_ids) THEN LEAST(p.refunded_amount, ${amt}::numeric) ELSE 0 END AS back
        FROM p
       WHERE NOT (('failed:' || ${refundId}::text) = ANY(p.refund_ids))
    ), upd_p AS (
      UPDATE invoice_payments ip SET
        refunded_amount = ip.refunded_amount - calc.back,
        refund_ids      = array_append(array_remove(ip.refund_ids, ${refundId}::text), 'failed:' || ${refundId}::text),
        updated_at      = NOW()
      FROM calc
      WHERE ip.id = calc.id
      RETURNING ip.invoice_id, calc.back
    ), upd_i AS (
      UPDATE invoices i SET
        refunded_amount = GREATEST(0, COALESCE(prev.refunded_amount, 0) - upd_p.back),
        status          = CASE
                            WHEN prev.status = 'refunded'
                             AND GREATEST(0, COALESCE(prev.refunded_amount, 0) - upd_p.back) < COALESCE(prev.paid_amount, prev.total) - 0.005
                            THEN 'paid'
                            ELSE prev.status
                          END,
        activity        = COALESCE(i.activity, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
                            'ts', ${ts}::text, 'kind', 'refund-failed', 'stripeRefundId', ${refundId}::text,
                            'text', 'Refund of $' || to_char(upd_p.back, 'FM999999990.00') || ${activityText}::text)),
        updated_at      = NOW()
      FROM upd_p, invoices prev
      WHERE i.id = upd_p.invoice_id AND prev.id = i.id AND i.workspace_id = ${workspaceId} AND upd_p.back > 0
      RETURNING i.id, i.number, i.client_name, i.status, prev.status AS prev_status
    )
    SELECT (SELECT back FROM upd_p) AS back, (SELECT row_to_json(upd_i) FROM upd_i) AS invoice
  `;
  const row = r.rows[0] || {};
  return { back: round2(row.back || 0), invoice: row.invoice || null };
}

// Split a refund across payments, newest first, each up to what it has
// left. Pure; `rows` newest first. Returns [{ row, amount }] (amounts in
// dollars, 2dp) and the part that could not be placed (0 when the rows
// cover it).
export function allocateRefund(rows, amount) {
  let left = Math.round(Number(amount) * 100);
  const parts = [];
  for (const row of rows) {
    if (left <= 0) break;
    const room = Math.round(Number(row.amount) * 100) - Math.round(Number(row.refunded_amount) * 100);
    if (room <= 0) continue;
    const take = Math.min(room, left);
    parts.push({ row, amount: take / 100 });
    left -= take;
  }
  return { parts, unplaced: left / 100 };
}
