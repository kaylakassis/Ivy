// Saved card for repeat invoices.
//
// A client who pays a business's invoice by card can tick "Save this card
// for future invoices from <business>". The card lives in Stripe on the
// BUSINESS'S connected account (a Customer there, keyed to the client's
// email within that workspace); Ivy keeps only the Stripe customer id, the
// payment method id and the brand / last4 / expiry on the clients row - the
// same columns the portal's "save a card on file" flow already uses, so a
// card saved either way shows up on both surfaces. Raw card data never
// touches Ivy.
//
// Clients rows are workspace-scoped, so a card saved with business A is
// invisible to business B by construction: every read and write here is
// pinned to (clients.id, clients.workspace_id).
import { sql } from './db.js';
import {
  findOrCreateCustomer, fetchPaymentIntent, fetchPaymentMethod,
  setDefaultPaymentMethod, chargeOffSession,
} from './stripe.js';

// Display fragments only - never Stripe ids.
export function describeSavedCard(row) {
  if (!row?.payment_method_id) return null;
  return {
    brand:    row.payment_method_brand || null,
    last4:    row.payment_method_last4 || null,
    expMonth: row.payment_method_exp_month || null,
    expYear:  row.payment_method_exp_year || null,
  };
}

// The saved card the public invoice page may offer for THIS invoice: the
// invoice's own client row in the invoice's own workspace. Returns the raw
// row (ids included) for server use; callers expose describeSavedCard().
export async function savedCardRowForInvoice(inv) {
  if (!inv?.client_id || !inv?.workspace_id) return null;
  const { rows } = await sql`
    SELECT id, workspace_id, email, name, stripe_customer_id,
           payment_method_id, payment_method_brand, payment_method_last4,
           payment_method_exp_month, payment_method_exp_year
      FROM clients
     WHERE id = ${inv.client_id} AND workspace_id = ${inv.workspace_id}
     LIMIT 1
  `;
  return rows[0] || null;
}

// Find or mint the Stripe Customer (on the connected account) for a client
// and remember its id. Workspace-pinned UPDATE so a bad client id can never
// link a customer onto another tenant's row.
export async function ensureStripeCustomer({ creds, client }) {
  if (client.stripe_customer_id) return client.stripe_customer_id;
  if (!client.email) return null;
  const cust = await findOrCreateCustomer({
    secretKey: creds.secretKey, stripeAccount: creds.stripeAccount,
    email: client.email, name: client.name,
    workspaceId: client.workspace_id, clientId: client.id,
  });
  await sql`
    UPDATE clients SET stripe_customer_id = ${cust.id}, updated_at = NOW()
     WHERE id = ${client.id} AND workspace_id = ${client.workspace_id}
  `;
  return cust.id;
}

// After a Checkout payment that asked for setup_future_usage, read the
// PaymentIntent's payment method and keep brand/last4/expiry + ids on the
// client row. Idempotent (plain overwrite with the same values). Returns
// the stored display fragment or null when nothing could be saved.
export async function storeCardFromPaymentIntent({ creds, workspaceId, clientId, paymentIntentId, customerId = null }) {
  if (!creds || !workspaceId || !clientId || !paymentIntentId) return null;
  const pi = await fetchPaymentIntent({
    secretKey: creds.secretKey, stripeAccount: creds.stripeAccount, paymentIntentId,
  });
  const pmId = typeof pi.payment_method === 'string' ? pi.payment_method : pi.payment_method?.id;
  if (!pmId) return null;
  // Only reusable methods are worth keeping; a one-off card (no
  // setup_future_usage) or a bank debit is not a saved card.
  if (pi.setup_future_usage !== 'off_session' && pi.setup_future_usage !== 'on_session') return null;
  const pm = typeof pi.payment_method === 'object' && pi.payment_method?.card
    ? pi.payment_method
    : await fetchPaymentMethod({ secretKey: creds.secretKey, stripeAccount: creds.stripeAccount, paymentMethodId: pmId });
  if (pm?.type && pm.type !== 'card') return null;
  const card = pm?.card || {};
  const cust = customerId || (typeof pi.customer === 'string' ? pi.customer : pi.customer?.id) || null;
  const upd = await sql`
    UPDATE clients SET
      stripe_customer_id       = COALESCE(${cust}, stripe_customer_id),
      payment_method_id        = ${pmId},
      payment_method_brand     = ${card.brand || null},
      payment_method_last4     = ${card.last4 || null},
      payment_method_exp_month = ${card.exp_month || null},
      payment_method_exp_year  = ${card.exp_year || null},
      updated_at               = NOW()
    WHERE id = ${clientId} AND workspace_id = ${workspaceId}
    RETURNING payment_method_id, payment_method_brand, payment_method_last4,
              payment_method_exp_month, payment_method_exp_year
  `;
  if (upd.rows.length === 0) return null;
  if (cust) {
    try {
      await setDefaultPaymentMethod({
        secretKey: creds.secretKey, stripeAccount: creds.stripeAccount,
        customerId: cust, paymentMethodId: pmId,
      });
    } catch { /* non-fatal */ }
  }
  return describeSavedCard(upd.rows[0]);
}

// Charge an invoice off-session with the client's saved card on the
// connected account. Returns one of:
//   { outcome: 'succeeded', paymentIntent }   - money moved; caller fulfils
//   { outcome: 'requires_action', paymentIntent? } - bank wants 3DS; caller
//                                               falls back to Checkout
//   { outcome: 'declined', message }          - card refused; caller offers
//                                               another way to pay
// Never throws for Stripe-side outcomes; only for programmer errors.
export async function chargeInvoiceWithSavedCard({ creds, inv, client, amountCents, currency }) {
  if (!client?.stripe_customer_id || !client?.payment_method_id) {
    return { outcome: 'declined', message: 'No saved card on file for this business.' };
  }
  try {
    const pi = await chargeOffSession({
      secretKey: creds.secretKey, stripeAccount: creds.stripeAccount,
      customerId: client.stripe_customer_id,
      paymentMethodId: client.payment_method_id,
      amountCents, currency,
      description: `Invoice ${inv.number}`,
      metadata: {
        invoice_id: inv.id, invoice_number: inv.number, workspace_id: inv.workspace_id,
        client_id: client.id, source: 'saved_card',
      },
      // One charge per invoice + amount: a double tap or a function retry
      // returns Stripe's original PaymentIntent instead of charging twice.
      idempotencyKey: `inv-saved-${inv.id}-${amountCents}`,
    });
    if (pi.status === 'succeeded') return { outcome: 'succeeded', paymentIntent: pi };
    if (pi.status === 'requires_action' || pi.status === 'requires_confirmation' || pi.status === 'requires_payment_method') {
      return { outcome: 'requires_action', paymentIntent: pi };
    }
    if (pi.status === 'processing') return { outcome: 'succeeded', paymentIntent: pi, processing: true };
    return { outcome: 'declined', message: 'The saved card could not be charged.' };
  } catch (err) {
    // Stripe answers 402 with code authentication_required when the bank
    // insists on 3DS for an off-session charge; everything else is a
    // decline the client has to resolve with a different card.
    if (err.stripeCode === 'authentication_required' || /authentication/i.test(err.message || '')) {
      return { outcome: 'requires_action' };
    }
    return { outcome: 'declined', message: err.message || 'The saved card was declined.' };
  }
}
