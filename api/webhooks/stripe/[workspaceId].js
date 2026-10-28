// POST /api/webhooks/stripe/:workspaceId  (public, signature-verified)
// Stripe posts here when a checkout session for one of the workspace's
// invoices completes. Each workspace has its own webhook URL with their
// own signing secret - pasted into Stripe dashboard's webhook config -
// so verification is scoped to the right tenant by construction.
//
// Body parsing is disabled because the Stripe-Signature header is computed
// over the exact raw bytes; any re-encoding (e.g. JSON parse + stringify)
// would break verification.
import { sql } from '../../_lib/db.js';
import { readRawBody } from '../../_lib/body.js';
import { decrypt } from '../../_lib/secrets.js';
import { verifyWebhookSignature, fetchPaymentMethod, setDefaultPaymentMethod } from '../../_lib/stripe.js';
import { loadStripeCreds } from '../../_lib/stripeCreds.js';
import { applySubscriptionState } from '../../_lib/memberships.js';
import {
  fulfillCheckoutSession, fulfillInvoicePaymentIntent, failInvoiceAsyncPayment,
} from '../../_lib/checkoutFulfillment.js';
import { markProcessed, releaseProcessed } from '../../_lib/webhookDedup.js';
import { fetchWithTimeout } from '../../_lib/fetchTimeout.js';
import { methodNotAllowed, ok, serverError } from '../../_lib/json.js';
import { recordWebhookFailure, SIGNATURE_FAILURE } from '../../_lib/webhookFailures.js';

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  // Tracks a dedup claim so a mid-handler throw can release it (below),
  // letting the provider's retry re-process instead of being deduped.
  let claimedEventId = null;
  let eventType = null;
  try {
    const workspaceId = (req.query.workspaceId || '').toString();
    if (!/^[0-9a-fA-F-]{36}$/.test(workspaceId)) {
      return res.status(400).json({ error: 'Invalid workspace id' });
    }

    const { rows } = await sql`
      SELECT stripe_webhook_secret_encrypted, stripe_secret_encrypted
      FROM finance_settings
      WHERE workspace_id = ${workspaceId}
    `;
    const enc = rows[0]?.stripe_webhook_secret_encrypted;
    if (!enc) return res.status(404).json({ error: 'Webhook not configured for this workspace' });

    let webhookSecret;
    try { webhookSecret = decrypt(enc); }
    catch { return res.status(500).json({ error: 'Could not load webhook secret' }); }

    // Resolve credentials for downstream Stripe API calls (SetupIntent
    // fetch, payment-method ops). loadStripeCreds returns the right
    // shape for both flows; if the workspace has neither legacy secret
    // nor completed Account-Links onboarding, the save-card branches
    // below skip gracefully.
    let workspaceCreds = null;
    try { workspaceCreds = await loadStripeCreds(workspaceId); }
    catch { /* no_stripe_connection - non-fatal here */ }

    const rawBody = await readRawBody(req);
    let event;
    try {
      event = verifyWebhookSignature({
        payload: rawBody,
        header: req.headers['stripe-signature'],
        secret: webhookSecret,
      });
    } catch (err) {
      await recordWebhookFailure({ source: 'stripe', eventType: SIGNATURE_FAILURE, message: err.message });
      return res.status(400).json({ error: `Webhook verification failed: ${err.message}` });
    }
    eventType = event.type;

    // Dedup BEFORE any business logic. Stripe retries for ~3 days on
    // non-2xx responses (and on timeout); without this, a handler
    // that crashed mid-write would re-process on every retry, with
    // only the in-row "status='paid' already?" guard between us and
    // duplicate work (or duplicate side effects like push, email).
    if (!await markProcessed('stripe', event.id, workspaceId)) {
      return ok(res, { received: true, deduped: true });
    }
    claimedEventId = event.id;

    // Subscription lifecycle for memberships. We only act on the
    // events that move client_memberships state; everything else is
    // 200-ignored so Stripe stops retrying.
    if (event.type === 'customer.subscription.created'
     || event.type === 'customer.subscription.updated'
     || event.type === 'customer.subscription.deleted') {
      const sub = event.data?.object || {};
      const eventWorkspaceId = sub.metadata?.workspace_id;
      if (eventWorkspaceId && eventWorkspaceId !== workspaceId) {
        return res.status(400).json({ error: 'workspace mismatch' });
      }
      // No metadata.purpose gate: applySubscriptionState resolves both
      // Ivy-originated and Stripe-Dashboard-originated subs by
      // matching customer + price. Subs that don't map are returned
      // as 'race' / 'mismatch' and quietly dropped. stripeContext lets
      // applySubscriptionState fetch unknown customers and auto-
      // provision a clients row on the Dashboard path.
      let stripeContext;
      try {
        const c = await loadStripeCreds(workspaceId);
        stripeContext = { secretKey: c.secretKey, stripeAccount: c.stripeAccount };
      } catch { /* no creds available - fall back to pure-DB matching */ }
      const result = await applySubscriptionState({ workspaceId, sub, stripeContext });
      return ok(res, { received: true, applied: 'membership-state', result });
    }

    // payment_intent.succeeded - safety net for invoice payments.
    // Stripe fans a single Checkout payment into both events; if
    // checkout.session.completed is dropped for any reason (or the
    // payment came in via chargeOffSession rather than Checkout), the
    // PI event still marks the invoice paid. markInvoicePaid is
    // idempotent so the duplicate from the pair is a no-op. Booking
    // deposits (invoice_id 'bookdep_…') skip - they ride session.completed.
    if (event.type === 'payment_intent.succeeded') {
      const pi = event.data?.object || {};
      const invoiceId = pi.metadata?.invoice_id;
      const eventWorkspaceId = pi.metadata?.workspace_id;
      // Storefront orders carry order_id, not invoice_id. Shared with the
      // platform webhook so legacy-keys workspaces don't strand paid
      // orders in 'pending' (fulfillment is idempotent on status).
      if (pi.metadata?.order_id) {
        if (eventWorkspaceId && eventWorkspaceId !== workspaceId) {
          return res.status(400).json({ error: 'workspace mismatch' });
        }
        const { markOrderPaidFromPI } = await import('../../_lib/checkoutFulfillment.js');
        const result = await markOrderPaidFromPI({ workspaceId, pi });
        return ok(res, { received: true, ...result });
      }
      if (!invoiceId) {
        return ok(res, { received: true, ignored: 'no invoice_id in metadata' });
      }
      if (invoiceId.startsWith('bookdep_')) {
        return ok(res, { received: true, ignored: 'booking deposit handled via session.completed' });
      }
      if (eventWorkspaceId && eventWorkspaceId !== workspaceId) {
        return res.status(400).json({ error: 'workspace mismatch' });
      }
      const result = await fulfillInvoicePaymentIntent({ workspaceId, pi, creds: workspaceCreds });
      return ok(res, { received: true, applied: 'invoice-paid', result });
    }

    // Delayed methods (ACH Direct Debit) settle through this pair. Same
    // idempotent fulfilment as a paid completion / a failure that leaves the
    // invoice open and tells both sides.
    if (event.type === 'checkout.session.async_payment_succeeded') {
      const session = event.data?.object || {};
      if (session.metadata?.workspace_id && session.metadata.workspace_id !== workspaceId) {
        return res.status(400).json({ error: 'workspace mismatch' });
      }
      const result = await fulfillCheckoutSession({ workspaceId, session, creds: workspaceCreds, settledAsync: true });
      return ok(res, { received: true, ...result });
    }
    if (event.type === 'checkout.session.async_payment_failed') {
      const session = event.data?.object || {};
      if (session.metadata?.workspace_id && session.metadata.workspace_id !== workspaceId) {
        return res.status(400).json({ error: 'workspace mismatch' });
      }
      if (!session.metadata?.invoice_id || String(session.metadata.invoice_id).startsWith('bookdep_')) {
        return ok(res, { received: true, ignored: 'async failure outside the invoice flow' });
      }
      const result = await failInvoiceAsyncPayment({ workspaceId, session });
      return ok(res, { received: true, applied: 'invoice-payment-failed', result });
    }

    // Only checkout.session.completed remains as the path that
    // moves money / saves cards. Other event types succeed quietly.
    if (event.type !== 'checkout.session.completed') {
      return ok(res, { received: true, ignored: event.type });
    }

    const session = event.data?.object || {};
    const sessionId = session.id;
    const invoiceId = session.metadata?.invoice_id;
    const eventWorkspaceId = session.metadata?.workspace_id;

    // Reject events for the wrong workspace - defends against a misconfigured
    // owner pasting another workspace's webhook URL into Stripe.
    if (eventWorkspaceId && eventWorkspaceId !== workspaceId) {
      return res.status(400).json({ error: 'workspace mismatch' });
    }

    // Setup mode: client portal "save a card" flow. After Stripe
    // confirms the SetupIntent, fetch the resulting PaymentMethod
    // for the brand/last4/exp display fragments and stamp it on the
    // client row, plus set it as the customer's default for future
    // off-session charges.
    if (session.mode === 'setup' && session.metadata?.purpose === 'save_card') {
      const clientId = session.metadata?.client_id;
      const setupIntentId = typeof session.setup_intent === 'string'
        ? session.setup_intent
        : session.setup_intent?.id;
      if (!clientId || !setupIntentId) {
        return ok(res, { received: true, ignored: 'setup metadata incomplete' });
      }
      try {
        if (!workspaceCreds) {
          return ok(res, { received: true, ignored: 'workspace stripe not connected' });
        }
        // Re-fetch the SetupIntent so we get the resulting
        // payment_method id (which the SetupIntent confirms in
        // Stripe AFTER the client clicks confirm in Checkout).
        const siHeaders = {
          Authorization: `Bearer ${workspaceCreds.secretKey}`,
        };
        if (workspaceCreds.stripeAccount) {
          siHeaders['Stripe-Account'] = workspaceCreds.stripeAccount;
        }
        const siResp = await fetchWithTimeout(
          `https://api.stripe.com/v1/setup_intents/${encodeURIComponent(setupIntentId)}`,
          { headers: siHeaders },
        );
        const si = await siResp.json();
        if (!siResp.ok) {
          // eslint-disable-next-line no-console
          console.error('[webhook] setup_intent fetch failed:', si?.error?.message);
          return ok(res, { received: true, ignored: 'setup_intent fetch failed' });
        }
        const paymentMethodId = typeof si.payment_method === 'string'
          ? si.payment_method
          : si.payment_method?.id;
        if (!paymentMethodId) return ok(res, { received: true, ignored: 'no payment_method on setup_intent' });
        const pm = await fetchPaymentMethod({
          secretKey: workspaceCreds.secretKey,
          stripeAccount: workspaceCreds.stripeAccount,
          paymentMethodId,
        });
        const card = pm.card || {};
        await sql`
          UPDATE clients SET
            payment_method_id = ${paymentMethodId},
            payment_method_brand = ${card.brand || null},
            payment_method_last4 = ${card.last4 || null},
            payment_method_exp_month = ${card.exp_month || null},
            payment_method_exp_year = ${card.exp_year || null},
            updated_at = NOW()
          WHERE id = ${clientId} AND workspace_id = ${workspaceId}
        `;
        // Make this the customer's default so off-session charges (no-show
        // fees, tips) don't have to specify the PM each time.
        if (typeof session.customer === 'string') {
          try {
            await setDefaultPaymentMethod({
              secretKey:     workspaceCreds.secretKey,
              stripeAccount: workspaceCreds.stripeAccount,
              customerId:    session.customer,
              paymentMethodId,
            });
          } catch { /* non-fatal */ }
        }
        return ok(res, { received: true, marked: 'card-saved' });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[webhook] save-card flow failed:', err.message);
        return ok(res, { received: true, ignored: 'save-card error: ' + err.message });
      }
    }

    // Membership purchase: subscription Checkout completed. Webhook
    // creates the client_memberships row; the customer.subscription.*
    // events then keep status in sync over time.
    if (session.mode === 'subscription' && session.metadata?.purpose === 'membership') {
      // Defense-in-depth: reject events with metadata.workspace_id !==
      // URL workspaceId. Mirrors the same check used for invoice
      // payments + gift cards above.
      if (eventWorkspaceId && eventWorkspaceId !== workspaceId) {
        return res.status(400).json({ error: 'workspace mismatch (membership)' });
      }
      const membershipId = session.metadata?.membership_id;
      const clientIdMeta = session.metadata?.client_id || null;
      const subscriptionId = typeof session.subscription === 'string'
        ? session.subscription
        : session.subscription?.id;
      const customerId = typeof session.customer === 'string'
        ? session.customer
        : session.customer?.id;
      if (!membershipId || !subscriptionId) {
        return ok(res, { received: true, ignored: 'membership metadata incomplete' });
      }
      // Look up the membership template + the client row by the
      // metadata's client_id (preferred) or by Stripe customer email
      // fallback - the public sign-up flow may not have a client_id
      // yet for first-time buyers.
      const m = await sql`
        SELECT id, name, price_cents, interval FROM memberships
         WHERE id = ${membershipId} AND workspace_id = ${workspaceId}
      `;
      if (m.rows.length === 0) {
        return ok(res, { received: true, ignored: 'unknown membership' });
      }
      const tier = m.rows[0];

      let clientId = clientIdMeta;
      if (!clientId && session.customer_details?.email) {
        const cl = await sql`
          SELECT id FROM clients
           WHERE workspace_id = ${workspaceId}
             AND email = ${String(session.customer_details.email).toLowerCase()}
           LIMIT 1
        `;
        if (cl.rows.length > 0) clientId = cl.rows[0].id;
        else {
          // First-time buyer with no clients-row yet - provision one
          // as a 'lead' so the membership has somewhere to attach.
          const ins = await sql`
            INSERT INTO clients (workspace_id, name, email, stage, source)
            VALUES (${workspaceId},
                    ${session.customer_details?.name || session.customer_details?.email},
                    ${String(session.customer_details.email).toLowerCase()},
                    'active', 'membership')
            RETURNING id
          `;
          clientId = ins.rows[0].id;
        }
      }
      if (!clientId) {
        return ok(res, { received: true, ignored: 'no client linkage' });
      }

      // Persist Stripe customer id on the client row for future tips
      // / fees off the same card. Workspace-scoped UPDATE so a webhook
      // event can't link a customer onto a client outside this tenant.
      if (customerId) {
        await sql`
          UPDATE clients SET stripe_customer_id = ${customerId}
           WHERE id = ${clientId}
             AND workspace_id = ${workspaceId}
             AND stripe_customer_id IS NULL
        `;
      }

      // Idempotent: if we already saw this subscription, skip. Scoped
      // to workspace so cross-tenant subscription IDs (theoretically
      // impossible since Stripe accounts are per-workspace, but
      // defense-in-depth) don't suppress a legitimate insert.
      const exists = await sql`
        SELECT id FROM client_memberships
         WHERE stripe_subscription_id = ${subscriptionId}
           AND workspace_id = ${workspaceId}
      `;
      if (exists.rows.length === 0) {
        await sql`
          INSERT INTO client_memberships (
            workspace_id, client_id, membership_id,
            membership_name, price_cents, interval,
            stripe_subscription_id, status
          ) VALUES (
            ${workspaceId}, ${clientId}, ${tier.id},
            ${tier.name}, ${tier.price_cents}, ${tier.interval},
            ${subscriptionId}, 'active'
          )
        `;
      }
      return ok(res, { received: true, marked: 'membership-active' });
    }

    // Invoice, booking deposit, package, program and gift card all go
    // through the shared dispatcher, which fulfils ONLY when
    // payment_status === 'paid'. An ACH Direct Debit session arrives
    // 'unpaid' and is stamped "payment processing" until the
    // async_payment_succeeded event above lands.
    if (invoiceId && !String(invoiceId).startsWith('bookdep_') && session.payment_status === 'paid') {
      // Legacy guard: the owner may have minted a newer checkout link for
      // this invoice; a stale session's event must not mark it paid.
      const { rows: invRows } = await sql`
        SELECT stripe_session_id, status FROM invoices WHERE id = ${invoiceId} AND workspace_id = ${workspaceId}
      `;
      const inv = invRows[0];
      if (!inv) return ok(res, { received: true, ignored: 'invoice not found' });
      if (inv.status === 'paid') return ok(res, { received: true, ignored: 'already paid' });
      if (sessionId && inv.stripe_session_id && inv.stripe_session_id !== sessionId) {
        return ok(res, { received: true, ignored: 'session id mismatch' });
      }
    }
    const result = await fulfillCheckoutSession({ workspaceId, session, creds: workspaceCreds });
    return ok(res, { received: true, ...result });
  } catch (err) {
    // Processing threw after we claimed the event - release the claim so
    // Stripe's retry re-runs the handler rather than getting deduped.
    if (claimedEventId) await releaseProcessed('stripe', claimedEventId);
    await recordWebhookFailure({ source: 'stripe', eventType: eventType || 'processing', message: err.message });
    return serverError(res, err);
  }
}

// Mirrors a Stripe subscription's lifecycle into client_memberships.
// Called from customer.subscription.{created,updated,deleted}.
//
// Status mapping:
//   'active' / 'trialing'              → 'active'
//   'past_due' / 'unpaid'              → 'past_due'
//   'canceled'                          → 'cancelled'
// Subscription-state logic moved to api/_lib/memberships.js so the
// platform-level webhook for Account-Links workspaces can use the
// same applySubscriptionState() + mapSubStatus() helpers.
