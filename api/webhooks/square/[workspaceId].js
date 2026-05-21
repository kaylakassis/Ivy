// POST /api/webhooks/square/:workspaceId
// Square sends payment events here. Each workspace gets its own URL
// segment so we can scope the workspace before signature verification.
// Configure the URL on the per-merchant level in Square's Developer
// Dashboard → Webhooks (separate signature key per subscription).
//
// Body parsing disabled because the HMAC is computed over the exact
// raw bytes — re-encoding breaks verification.
import { sql } from '../../_lib/db.js';
import { readRawBody } from '../../_lib/body.js';
import { verifyWebhook, parseWebhookEvent } from '../../_lib/payments/square.js';
import { fetchFinanceSettings } from '../../_lib/finance.js';
import { markProcessed, releaseProcessed } from '../../_lib/webhookDedup.js';
import { methodNotAllowed, ok, serverError } from '../../_lib/json.js';
import { appUrl } from '../../_lib/tokens.js';

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  let claimedEventId = null;
  try {
    const { workspaceId } = req.query;
    const settings = await fetchFinanceSettings(workspaceId);
    if (!settings?.squareMerchantId) return res.status(404).json({ error: 'Workspace not connected to Square' });

    const rawBody = await readRawBody(req);
    // Square computes the HMAC over (notification_url + body), where
    // notification_url is the EXACT URL registered in its dashboard. That
    // URL is stable, so we must derive it from the canonical APP_URL —
    // never from VERCEL_URL (changes every deploy → guaranteed signature
    // mismatch → every Square payment webhook silently rejected).
    const canonicalHost = process.env.APP_URL?.replace(/\/$/, '');
    if (!canonicalHost) {
      // eslint-disable-next-line no-console
      console.error('[square webhook] APP_URL is not set — Square HMAC will not match the registered notification URL. Set APP_URL to your canonical host.');
    }
    const notificationUrl = `${canonicalHost || appUrl()}/api/webhooks/square/${workspaceId}`;
    let event;
    try {
      event = verifyWebhook({ rawBody, headers: req.headers, notificationUrl });
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

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
    }
    return ok(res, { handled: true });
  } catch (err) {
    // Release the dedup claim so Square's retry re-processes (its natural
    // guards keep the re-run from double-applying).
    if (claimedEventId) await releaseProcessed('square', claimedEventId);
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
// payment-id field — see api/invoices/refund.js which keys off it).
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
    console.warn('[webhooks/square] no invoice matches order', orderId, '— ignoring');
    return;
  }
  const invoiceId = inv.id;

  // Already-paid + same payment id → silent no-op (webhook retry).
  if (inv.status === 'paid' && inv.stripe_payment_intent === parsed.paymentId) return;
  if (inv.status === 'paid') {
    console.warn('[webhooks/square] invoice', invoiceId, 'already paid by a different payment id — ignoring');
    return;
  }

  const paidAmountDollars = Math.round(Number(parsed.amountCents || 0)) / 100;
  const newActivity = [
    ...(inv.activity || []),
    {
      ts: new Date().toISOString(),
      kind: 'paid',
      text: `Paid by Square · $${paidAmountDollars.toFixed(2)}`,
    },
  ];

  await sql`
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
  `;
}

// Apply a Square refund event to the matching invoice. Triggers:
//   - Owner clicks Refund in THRYVE → /api/invoices/refund calls Square →
//     Square responds PENDING → eventual refund.updated webhook with
//     COMPLETED arrives here. We bump refunded_amount + activity entry.
//   - Owner refunds directly in Square dashboard → same webhook → same
//     code path. Without this, the invoice stays 'paid' in THRYVE while
//     the customer's money is back. Status flips to 'refunded' when the
//     cumulative refund amount reaches the invoice total.
//
// Dedupes by event refund_id stored in the activity log (we already
// stamp it from the invoices/refund.js path), AND by paid_amount
// reconciliation — if cumulative refunds match what's already recorded,
// skip the write.
async function applyRefundToInvoice({ workspaceId, parsed }) {
  // Find the invoice via the payment we stored when the original
  // checkout completed. stripe_payment_intent doubles as the generic
  // provider payment-id field — Square pays us by payment_id, refunds
  // reference that same payment_id, so we match on it.
  if (!parsed.paymentId) return;
  const { rows: invRows } = await sql`
    SELECT * FROM invoices
    WHERE workspace_id = ${workspaceId} AND stripe_payment_intent = ${parsed.paymentId}
    LIMIT 1
  `;
  const inv = invRows[0];
  if (!inv) {
    console.warn('[webhooks/square] no invoice matches payment', parsed.paymentId, '— ignoring refund');
    return;
  }
  const refundAmount = Math.round(Number(parsed.amountCents || 0)) / 100;
  if (refundAmount <= 0) return;

  // Idempotency: if this exact refund id has already been recorded in
  // the activity log, skip. The invoices/refund.js path stamps
  // stripeRefundId on the activity entry it appends, so dashboard
  // refunds and our-initiated refunds dedupe through the same shape.
  const activity = inv.activity || [];
  if (parsed.refundId && activity.some((a) => a.kind === 'refund' && a.stripeRefundId === parsed.refundId)) {
    return;
  }

  const alreadyRefunded = Number(inv.refunded_amount || 0);
  const newRefunded = +(alreadyRefunded + refundAmount).toFixed(2);
  const paidAmount = Number(inv.paid_amount || 0);
  const fullyRefunded = paidAmount > 0 && newRefunded >= paidAmount - 0.005;
  const newStatus = fullyRefunded ? 'refunded' : inv.status;

  const newActivity = [
    ...activity,
    {
      ts: new Date().toISOString(),
      kind: 'refund',
      text: `Refunded $${refundAmount.toFixed(2)} (Square${parsed.reason ? ` · ${parsed.reason}` : ''})`,
      ...(parsed.refundId ? { stripeRefundId: parsed.refundId } : {}),
    },
  ];

  await sql`
    UPDATE invoices SET
      status          = ${newStatus},
      refunded_amount = ${newRefunded},
      refunded_at     = NOW(),
      activity        = ${JSON.stringify(newActivity)}::jsonb,
      updated_at      = NOW()
    WHERE id = ${inv.id} AND workspace_id = ${workspaceId}
  `;
}
