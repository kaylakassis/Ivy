// POST /api/webhooks/square/:workspaceId
// Square sends payment events here. Each workspace gets its own URL
// segment so we can scope the workspace before signature verification.
// Configure the URL on the per-merchant level in Square's Developer
// Dashboard → Webhooks (separate signature key per subscription).
//
// Body parsing disabled because the HMAC is computed over the exact
// raw bytes - re-encoding breaks verification.
import { sql } from '../../_lib/db.js';
import { readRawBody } from '../../_lib/body.js';
import { verifyWebhook, parseWebhookEvent } from '../../_lib/payments/square.js';
import { fetchFinanceSettings } from '../../_lib/finance.js';
import { invoicePaymentState } from '../../_lib/invoicePayments.js';
import { applyProviderRefundEvent, applyProviderRefundFailure } from '../../_lib/invoiceRefundSync.js';
import { markProcessed, releaseProcessed } from '../../_lib/webhookDedup.js';
import { methodNotAllowed, ok, serverError } from '../../_lib/json.js';
import { recordWebhookFailure, SIGNATURE_FAILURE } from '../../_lib/webhookFailures.js';
import { appUrl } from '../../_lib/tokens.js';
import { notifyOwnerSafe } from '../../_lib/push.js';
import { notifyInvoicePaid } from '../../_lib/invoiceNotify.js';

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  let claimedEventId = null;
  let eventType = null;
  try {
    const { workspaceId } = req.query;
    const settings = await fetchFinanceSettings(workspaceId);
    if (!settings?.squareMerchantId) return res.status(404).json({ error: 'Workspace not connected to Square' });

    const rawBody = await readRawBody(req);
    // Square computes the HMAC over (notification_url + body), where
    // notification_url is the EXACT URL registered in its dashboard. That
    // URL is stable, so we must derive it from the canonical APP_URL -
    // never from VERCEL_URL (changes every deploy → guaranteed signature
    // mismatch → every Square payment webhook silently rejected).
    const canonicalHost = process.env.APP_URL?.replace(/\/$/, '');
    if (!canonicalHost) {
      // eslint-disable-next-line no-console
      console.error('[square webhook] APP_URL is not set - Square HMAC will not match the registered notification URL. Set APP_URL to your canonical host.');
    }
    const notificationUrl = `${canonicalHost || appUrl()}/api/webhooks/square/${workspaceId}`;
    let event;
    try {
      event = verifyWebhook({ rawBody, headers: req.headers, notificationUrl });
    } catch (e) {
      await recordWebhookFailure({ source: 'square', eventType: SIGNATURE_FAILURE, message: e.message });
      return res.status(400).json({ error: e.message });
    }
    eventType = event?.type || null;

    // Dedup BEFORE parsing/processing. Square retries for ~24h on
    // non-2xx responses; without this a handler crash mid-write
    // would re-process on every retry. event.event_id is part of
    // Square's webhook envelope.
    if (!await markProcessed('square', event?.event_id, workspaceId)) {
      return ok(res, { handled: true, deduped: true });
    }
    claimedEventId = event?.event_id;

    const parsed = parseWebhookEvent(event);
    if (!parsed) return ok(res, { handled: false });

    if (parsed.type === 'checkout.completed' && parsed.status === 'paid') {
      // The order_id is the link between Square's order and the
      // metadata note we embedded at checkout creation. We persist the
      // payment row here so the next /api/billing/sync round-trip
      // (or the Finance UI refresh) sees the paid state.
      await applyPaymentToInvoice({ workspaceId, parsed });
    } else if (parsed.type === 'refund.updated' && parsed.status === 'succeeded') {
      // Dashboard-initiated refunds + completion-state for our own
      // refund.create calls (Square refunds settle async).
      await applyRefundToInvoice({ workspaceId, parsed });
    } else if (parsed.type === 'refund.updated' && ['failed', 'rejected', 'canceled', 'cancelled'].includes(parsed.status)) {
      // A refund (made in Ivy, so already counted) that Square could not
      // complete: the money did not go back, so take it off the invoice
      // and tell the owner.
      await applyProviderRefundFailure({
        workspaceId, provider: 'square', paymentId: parsed.paymentId || null, refundId: parsed.refundId || null,
        amountCents: parsed.amountCents, label: 'Square',
      });
    }
    return ok(res, { handled: true });
  } catch (err) {
    // Release the dedup claim so Square's retry re-processes (its natural
    // guards keep the re-run from double-applying).
    if (claimedEventId) await releaseProcessed('square', claimedEventId);
    await recordWebhookFailure({ source: 'square', eventType: eventType || 'processing', message: err.message });
    return serverError(res, err);
  }
}

// Square's hosted checkout doesn't round-trip metadata, so we can't
// recover an invoice_id from the payment event. Instead, the order id
// is the link: createCheckoutSession() stashes payment_link.order_id
// into invoices.stripe_session_id, and the webhook's payment event
// arrives with payment.order_id matching that value. Look the invoice
// up by stripe_session_id.
//
// Idempotency: dedupe by Square payment_id stashed in
// stripe_payment_intent (the column doubles as a generic provider
// payment-id field - see api/invoices/refund.js which keys off it).
// Without this, a Square webhook retransmission would re-fire activity
// log entries + nag the owner with duplicate "paid" notifications.
async function applyPaymentToInvoice({ workspaceId, parsed }) {
  const orderId = parsed.sessionId; // Square parser: sessionId = p.order_id
  if (!orderId) return;

  const { rows: invRows } = await sql`
    SELECT * FROM invoices
    WHERE workspace_id = ${workspaceId} AND stripe_session_id = ${orderId}
    LIMIT 1
  `;
  const inv = invRows[0];
  if (!inv) {
    console.warn('[webhooks/square] no invoice matches order', orderId, '- ignoring');
    return;
  }
  const invoiceId = inv.id;

  // Already-paid + same payment id → silent no-op (webhook retry).
  if (inv.status === 'paid' && inv.stripe_payment_intent === parsed.paymentId) return;
  if (inv.status === 'paid') {
    console.warn('[webhooks/square] invoice', invoiceId, 'already paid by a different payment id - ignoring');
    return;
  }
  // Square re-sends payment.updated (still COMPLETED) when a payment is
  // refunded; that must never flip a refunded or void invoice back to paid.
  if (inv.status === 'refunded' || inv.status === 'voided') return;

  // Don't let a partial/under-capture (or currency mismatch) flip the
  // invoice to fully paid. Only settle when everything captured so far
  // covers what is due after any gift card (1¢ tolerance). The pay link
  // charges only what is left, so part payments add up; payment.created
  // and payment.updated for one payment count once.
  const st = invoicePaymentState(inv, { paymentId: parsed.paymentId || null, amountCents: Math.round(Number(parsed.amountCents || 0)) });
  if (st.seen) return;
  const paidAmountDollars = st.paidTotal;
  if (st.underpaid) {
    const partialActivity = [
      ...(inv.activity || []),
      { ts: new Date().toISOString(), kind: 'partial-payment', paymentId: parsed.paymentId || null,
        text: `Partial Square payment · $${st.thisPayment.toFixed(2)} · $${st.netPaid.toFixed(2)} of $${st.due.toFixed(2)} paid` },
    ];
    // The same statement writes this payment's ledger row (invoiceLedger.js).
    const part = await sql`
      WITH upd AS (
        UPDATE invoices SET
          paid_amount           = ${paidAmountDollars},
          paid_method           = 'card',
          stripe_payment_intent = ${parsed.paymentId || null},
          activity              = ${JSON.stringify(partialActivity)}::jsonb,
          updated_at            = NOW()
        WHERE id = ${invoiceId} AND workspace_id = ${workspaceId} AND status IN ('draft', 'sent', 'overdue')
          AND COALESCE(paid_amount, 0) = ${st.prior}
        RETURNING id, workspace_id, currency
      ), led AS (
        INSERT INTO invoice_payments (workspace_id, invoice_id, provider, provider_payment_id, amount, currency)
        SELECT workspace_id, id, 'square', ${parsed.paymentId || null}, ${st.thisPayment}::numeric, currency FROM upd
         WHERE ${st.thisPayment}::numeric > 0
        ON CONFLICT DO NOTHING
      )
      SELECT id FROM upd
    `;
    // Lost a race with another payment on the same invoice: count this one
    // on top of it (a throw lets Square retry the event).
    if (part.rows.length === 0 && !parsed._retried) return applyPaymentToInvoice({ workspaceId, parsed: { ...parsed, _retried: true } });
    return;
  }

  const newActivity = [
    ...(inv.activity || []),
    {
      ts: new Date().toISOString(),
      kind: 'paid',
      text: `Paid by Square · $${st.thisPayment.toFixed(2)}${st.prior > 0 ? ` · $${paidAmountDollars.toFixed(2)} in total` : ''}`,
    },
  ];

  const upd = await sql`
    WITH upd AS (
      UPDATE invoices SET
        status                = 'paid',
        paid_at               = NOW(),
        paid_amount           = ${paidAmountDollars},
        paid_method           = 'card',
        stripe_payment_intent = ${parsed.paymentId || null},
        view_token_hash       = NULL,
        activity              = ${JSON.stringify(newActivity)}::jsonb,
        updated_at            = NOW()
      WHERE id = ${invoiceId} AND workspace_id = ${workspaceId} AND status <> 'paid'
        AND COALESCE(paid_amount, 0) = COALESCE(${inv.paid_amount}::numeric, 0)
      RETURNING id, number, client_name, workspace_id, currency
    ), led AS (
      INSERT INTO invoice_payments (workspace_id, invoice_id, provider, provider_payment_id, amount, currency)
      SELECT workspace_id, id, 'square', ${parsed.paymentId || null}, ${st.thisPayment}::numeric, currency FROM upd
       WHERE ${st.thisPayment}::numeric > 0
      ON CONFLICT DO NOTHING
    )
    SELECT id, number, client_name FROM upd
  `;
  if (upd.rows.length === 0 && !parsed._retried) {
    const now = (await sql`SELECT status FROM invoices WHERE id = ${invoiceId} AND workspace_id = ${workspaceId}`).rows[0];
    if (now && !['paid', 'refunded', 'voided'].includes(now.status)) return applyPaymentToInvoice({ workspaceId, parsed: { ...parsed, _retried: true } });
  }
  // Race guard: a concurrent retry can land here too - if our UPDATE
  // didn't flip the row, somebody else's already did. Don't double-fire
  // the owner push or the client receipt email.
  if (upd.rows.length === 0) return;

  // Owner push + client receipt - parity with the Stripe path at
  // /api/webhooks/stripe/[workspaceId].js:482-502. Without these,
  // workspaces taking payment through Square saw "paid" land in their
  // dashboard but got no notification and the customer got no receipt.
  const number = upd.rows[0].number;
  const clientLabel = upd.rows[0].client_name || 'A client';
  notifyOwnerSafe({
    workspaceId,
    type: 'payments',
    payload: {
      title: 'Invoice paid',
      body: `${clientLabel} · ${number} · $${paidAmountDollars.toFixed(2)}`,
      url: `/finance?invoice=${invoiceId}`,
      tag: `inv-${invoiceId}`,
    },
  });
  notifyInvoicePaid({
    workspaceId, invoiceId, totalAmount: paidAmountDollars, method: 'square',
  });
}

// Apply a Square refund event to the payment it was made on. Triggers:
//   - Owner clicks Refund in Ivy → /api/invoices/refund calls Square →
//     Square responds PENDING → eventual refund.updated webhook with
//     COMPLETED arrives here. Ivy already counted that refund id on the
//     payment, so this adds nothing.
//   - Owner refunds directly in Square dashboard, against ANY payment on
//     the invoice → that payment's ledger row and the invoice totals move
//     (invoiceRefundSync.js). Without this, the invoice stays 'paid' in
//     Ivy while the customer's money is back. Status flips to 'refunded'
//     when everything paid is back.
// Counted once per refund id (a redelivery, or the app's own refund).
async function applyRefundToInvoice({ workspaceId, parsed }) {
  const out = await applyProviderRefundEvent({
    workspaceId, provider: 'square', paymentId: parsed.paymentId || null, refundId: parsed.refundId || null,
    amountCents: parsed.amountCents, reason: parsed.reason || null, label: 'Square',
  });
  if (out.result === 'not-found') {
    console.warn('[webhooks/square] no invoice matches payment', parsed.paymentId, '- ignoring refund');
  }
}
