// POST /api/webhooks/stripe/:workspaceId  (public, signature-verified)
// Stripe posts here when a checkout session for one of the workspace's
// invoices completes. Each workspace has its own webhook URL with their
// own signing secret — pasted into Stripe dashboard's webhook config —
// so verification is scoped to the right tenant by construction.
//
// Body parsing is disabled because the Stripe-Signature header is computed
// over the exact raw bytes; any re-encoding (e.g. JSON parse + stringify)
// would break verification.
import { sql } from '../../_lib/db.js';
import { readRawBody } from '../../_lib/body.js';
import { decrypt } from '../../_lib/secrets.js';
import { verifyWebhookSignature } from '../../_lib/stripe.js';
import { computeTotals } from '../../_lib/finance.js';
import { notifyOwnerSafe } from '../../_lib/push.js';
import { methodNotAllowed, ok, serverError } from '../../_lib/json.js';

export const config = { api: { bodyParser: false } };

function fmtMoney(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try {
    const workspaceId = (req.query.workspaceId || '').toString();
    if (!/^[0-9a-fA-F-]{36}$/.test(workspaceId)) {
      return res.status(400).json({ error: 'Invalid workspace id' });
    }

    const { rows } = await sql`
      SELECT stripe_webhook_secret_encrypted
      FROM finance_settings
      WHERE workspace_id = ${workspaceId}
    `;
    const enc = rows[0]?.stripe_webhook_secret_encrypted;
    if (!enc) return res.status(404).json({ error: 'Webhook not configured for this workspace' });

    let webhookSecret;
    try {
      webhookSecret = decrypt(enc);
    } catch {
      return res.status(500).json({ error: 'Could not load webhook secret' });
    }

    const rawBody = await readRawBody(req);
    let event;
    try {
      event = verifyWebhookSignature({
        payload: rawBody,
        header: req.headers['stripe-signature'],
        secret: webhookSecret,
      });
    } catch (err) {
      return res.status(400).json({ error: `Webhook verification failed: ${err.message}` });
    }

    // Only one event type matters right now. Other events succeed quietly so
    // Stripe doesn't keep retrying them.
    if (event.type !== 'checkout.session.completed') {
      return ok(res, { received: true, ignored: event.type });
    }

    const session = event.data?.object || {};
    const sessionId = session.id;
    const invoiceId = session.metadata?.invoice_id;
    const eventWorkspaceId = session.metadata?.workspace_id;

    // Reject events for the wrong workspace — defends against a misconfigured
    // owner pasting another workspace's webhook URL into Stripe.
    if (eventWorkspaceId && eventWorkspaceId !== workspaceId) {
      return res.status(400).json({ error: 'workspace mismatch' });
    }
    if (session.payment_status !== 'paid') {
      return ok(res, { received: true, ignored: `payment_status=${session.payment_status}` });
    }

    // Deposit checkout flow: the public booking endpoint stashes the
    // session_id on bookings.deposit_payment_intent as a forward
    // pointer. Recognize that pattern by metadata.invoice_id starting
    // with 'bookdep_' OR by looking up a booking with the session id.
    if ((invoiceId && String(invoiceId).startsWith('bookdep_')) || !invoiceId) {
      const { rows: bRows } = await sql`
        SELECT id, deposit_required, deposit_paid, activity FROM bookings
        WHERE workspace_id = ${workspaceId} AND deposit_payment_intent = ${sessionId}
        LIMIT 1
      `;
      if (bRows.length > 0) {
        const booking = bRows[0];
        const paymentIntent = typeof session.payment_intent === 'string'
          ? session.payment_intent
          : session.payment_intent?.id || null;
        await sql`
          UPDATE bookings SET
            deposit_paid           = ${booking.deposit_required},
            deposit_paid_at        = NOW(),
            deposit_payment_intent = ${paymentIntent}
          WHERE id = ${booking.id} AND workspace_id = ${workspaceId}
        `;
        return ok(res, { received: true, marked: 'deposit-paid', bookingId: booking.id });
      }
      // Fall through if no matching booking — invoice case below.
    }
    if (!invoiceId) return ok(res, { received: true, ignored: 'no metadata' });

    // Look up + verify the invoice belongs to this workspace before mutating.
    const { rows: invRows } = await sql`
      SELECT * FROM invoices
      WHERE id = ${invoiceId} AND workspace_id = ${workspaceId}
    `;
    const inv = invRows[0];
    if (!inv) return ok(res, { received: true, ignored: 'invoice not found' });

    // Idempotent — webhook retries shouldn't double-mark or re-append history.
    if (inv.status === 'paid') {
      return ok(res, { received: true, ignored: 'already paid' });
    }
    if (sessionId && inv.stripe_session_id && inv.stripe_session_id !== sessionId) {
      // The invoice was paid with a different session — likely the owner
      // generated a new checkout link after this one. Don't mark from a
      // stale event.
      return ok(res, { received: true, ignored: 'session id mismatch' });
    }

    const totals = computeTotals(inv.items || [], inv.tax_rate, inv.discount);
    const newActivity = [
      ...(inv.activity || []),
      {
        ts: new Date().toISOString(),
        kind: 'paid',
        text: `Paid by card · ${fmtMoney(totals.total)}`,
      },
    ];

    // Capture payment_intent so the refund endpoint can target it
    // without re-fetching the session every time.
    const paymentIntent = typeof session.payment_intent === 'string'
      ? session.payment_intent
      : session.payment_intent?.id || null;

    await sql`
      UPDATE invoices SET
        status                 = 'paid',
        paid_at                = NOW(),
        paid_method            = 'card',
        view_token_hash        = NULL,
        stripe_payment_intent  = ${paymentIntent},
        activity               = ${JSON.stringify(newActivity)}::jsonb,
        updated_at             = NOW()
      WHERE id = ${inv.id} AND workspace_id = ${workspaceId} AND status <> 'paid'
    `;

    // Proactive Ivy hand-off: tap the push to land in Ivy with a
    // ready-to-go thank-you prompt. The /ivy?prompt= deep link is
    // consumed by IvyPro on mount — see the useEffect there.
    const clientLabel = inv.client_name || 'A client';
    const totalLabel  = fmtMoney(totals.total);
    const ivyPrompt   = `Draft a short, warm thank-you message for ${clientLabel} who just paid invoice ${inv.number} (${totalLabel}). Then send it as a chat message to them.`;
    notifyOwnerSafe({
      workspaceId,
      type: 'payments',
      payload: {
        title: 'Invoice paid 💸',
        body: `${clientLabel} · ${inv.number} · ${totalLabel}. Tap to draft a thank-you with Ivy.`,
        url: `/ivy?prompt=${encodeURIComponent(ivyPrompt)}`,
        tag: `invoice-paid-${inv.id}`,
      },
    });

    return ok(res, { received: true, marked: 'paid' });
  } catch (err) {
    return serverError(res, err);
  }
}
