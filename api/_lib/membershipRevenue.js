// Membership renewals → invoice rows.
//
// Stripe subscription renewals fire `invoice.payment_succeeded` for
// every successful charge. The legacy and platform webhooks both
// route those events here so each renewal lands as a real paid
// invoice row in our local table. That makes recurring membership
// revenue first-class in the revenue tiles, the accounting export,
// and the year-end Schedule C — without changing any of those query
// surfaces.
//
// Idempotency: keyed on (workspace_id, source, source_id) where
// source='membership' and source_id = the Stripe invoice id. A
// retry, a race between the platform and legacy webhooks, or a
// Stripe replay all converge on the same single row.
import { sql } from './db.js';
import { nextInvoiceNumber } from './finance.js';

function fmtMoney(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Returns: { created: true, invoiceId } on first time,
//          { skipped: <reason>, invoiceId? } otherwise.
export async function recordMembershipRenewal({ workspaceId, stripeInvoice }) {
  const stripeInvoiceId = stripeInvoice?.id;
  const subscriptionId = typeof stripeInvoice?.subscription === 'string'
    ? stripeInvoice.subscription
    : stripeInvoice?.subscription?.id;
  if (!workspaceId || !stripeInvoiceId || !subscriptionId) {
    return { skipped: 'missing-ids' };
  }

  // Idempotency check first — every subsequent webhook re-delivery
  // for this Stripe invoice returns the existing row id.
  const existing = await sql`
    SELECT id FROM invoices
     WHERE workspace_id = ${workspaceId}
       AND source = 'membership'
       AND source_id = ${stripeInvoiceId}
     LIMIT 1
  `;
  if (existing.rows.length > 0) {
    return { skipped: 'already-recorded', invoiceId: existing.rows[0].id };
  }

  // Look up the membership + client. If we haven't seen the
  // subscription yet (initial checkout's webhook hasn't landed),
  // skip — Stripe will resend the invoice.payment_succeeded
  // event later on its retry schedule, and by then the
  // client_memberships row will exist.
  const mem = await sql`
    SELECT cm.client_id, cm.membership_name,
           c.name  AS client_name,
           c.email AS client_email
      FROM client_memberships cm
      LEFT JOIN clients c
        ON c.id = cm.client_id AND c.workspace_id = cm.workspace_id
     WHERE cm.stripe_subscription_id = ${subscriptionId}
       AND cm.workspace_id = ${workspaceId}
     LIMIT 1
  `;
  if (mem.rows.length === 0) return { skipped: 'no-membership' };
  const m = mem.rows[0];

  const amountCents = Number(stripeInvoice.amount_paid || 0);
  if (!(amountCents > 0)) return { skipped: 'zero-amount' };
  const amount = Math.round(amountCents) / 100;
  const currency = (stripeInvoice.currency || 'usd').toUpperCase();
  const paymentIntent = typeof stripeInvoice.payment_intent === 'string'
    ? stripeInvoice.payment_intent
    : stripeInvoice.payment_intent?.id || null;

  const num = await nextInvoiceNumber(workspaceId);
  const number = `INV-${num}`;
  const today = new Date().toISOString().slice(0, 10);
  const description = `Membership · ${m.membership_name || 'Subscription'}`;

  const ins = await sql`
    INSERT INTO invoices (
      workspace_id, number, client_id, client_name, client_email,
      issue_date, due_date, items, tax_rate, discount,
      status, paid_at, paid_method, paid_amount, stripe_payment_intent,
      activity, currency, source, source_id
    ) VALUES (
      ${workspaceId}, ${number},
      ${m.client_id}, ${m.client_name}, ${m.client_email},
      ${today}, ${today},
      ${JSON.stringify([{ id: 'li1', description, quantity: 1, rate: amount }])}::jsonb,
      0, 0,
      'paid', NOW(), 'card', ${amount}, ${paymentIntent},
      ${JSON.stringify([{
        ts: new Date().toISOString(),
        kind: 'paid',
        text: `Membership renewal · ${fmtMoney(amount)}`,
      }])}::jsonb,
      ${currency}, 'membership', ${stripeInvoiceId}
    )
    RETURNING id
  `;
  return { created: true, invoiceId: ins.rows[0].id };
}
