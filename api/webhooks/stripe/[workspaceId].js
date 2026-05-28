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
import { verifyWebhookSignature, fetchPaymentMethod, setDefaultPaymentMethod } from '../../_lib/stripe.js';
import { loadStripeCreds } from '../../_lib/stripeCreds.js';
import { applySubscriptionState } from '../../_lib/memberships.js';
import { computeTotals } from '../../_lib/finance.js';
import { notifyOwnerSafe } from '../../_lib/push.js';
import { notifyInvoicePaid } from '../../_lib/invoiceNotify.js';
import { markInvoicePaid } from '../../_lib/invoicePayments.js';
import { markProcessed, releaseProcessed } from '../../_lib/webhookDedup.js';
import { generateCode, hashCode, normalizeCode } from '../../_lib/giftCards.js';
import { sendEmail, emailShell } from '../../_lib/email.js';
import { fetchBranding } from '../../_lib/branding.js';
import { methodNotAllowed, ok, serverError } from '../../_lib/json.js';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export const config = { api: { bodyParser: false } };

function fmtMoney(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  // Tracks a dedup claim so a mid-handler throw can release it (below),
  // letting the provider's retry re-process instead of being deduped.
  let claimedEventId = null;
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
    catch { /* no_stripe_connection — non-fatal here */ }

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
      // THRYVE-originated and Stripe-Dashboard-originated subs by
      // matching customer + price. Subs that don't map are returned
      // as 'race' / 'mismatch' and quietly dropped.
      const result = await applySubscriptionState({ workspaceId, sub });
      return ok(res, { received: true, applied: 'membership-state', result });
    }

    // payment_intent.succeeded — safety net for invoice payments.
    // Stripe fans a single Checkout payment into both events; if
    // checkout.session.completed is dropped for any reason (or the
    // payment came in via chargeOffSession rather than Checkout), the
    // PI event still marks the invoice paid. markInvoicePaid is
    // idempotent so the duplicate from the pair is a no-op. Booking
    // deposits (invoice_id 'bookdep_…') skip — they ride session.completed.
    if (event.type === 'payment_intent.succeeded') {
      const pi = event.data?.object || {};
      const invoiceId = pi.metadata?.invoice_id;
      const eventWorkspaceId = pi.metadata?.workspace_id;
      if (!invoiceId) {
        return ok(res, { received: true, ignored: 'no invoice_id in metadata' });
      }
      if (invoiceId.startsWith('bookdep_')) {
        return ok(res, { received: true, ignored: 'booking deposit handled via session.completed' });
      }
      if (eventWorkspaceId && eventWorkspaceId !== workspaceId) {
        return res.status(400).json({ error: 'workspace mismatch' });
      }
      const result = await markInvoicePaid({
        workspaceId, invoiceId, paymentIntent: pi.id,
        amountCents: pi.amount_received,
      });
      return ok(res, { received: true, applied: 'invoice-paid', result });
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

    // Reject events for the wrong workspace — defends against a misconfigured
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
        const siResp = await fetch(
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
      // fallback — the public sign-up flow may not have a client_id
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
          // First-time buyer with no clients-row yet — provision one
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

    // Gift card purchase: mode='payment' + metadata.purpose='gift_card'.
    // Mint the code on payment-succeeded, store hashed code, email the
    // recipient with the raw code. Idempotent on the Stripe payment_intent.
    if (session.mode === 'payment' && session.metadata?.purpose === 'gift_card' && session.payment_status === 'paid') {
      // Defense-in-depth: reject events whose metadata.workspace_id
      // disagrees with the URL's workspaceId. Signature verification
      // already pinned this event to one workspace's secret, so this
      // is belt-and-braces against a misconfigured webhook URL.
      if (eventWorkspaceId && eventWorkspaceId !== workspaceId) {
        return res.status(400).json({ error: 'workspace mismatch (gift card)' });
      }
      const paymentIntentId = typeof session.payment_intent === 'string'
        ? session.payment_intent : session.payment_intent?.id || null;
      if (paymentIntentId) {
        const dup = await sql`
          SELECT id FROM gift_cards
           WHERE stripe_payment_intent = ${paymentIntentId}
             AND workspace_id = ${workspaceId}
           LIMIT 1
        `;
        if (dup.rows.length > 0) {
          return ok(res, { received: true, ignored: 'gift card already issued for this PI' });
        }
      }
      const amountCents = Number(session.metadata?.amount_cents || 0);
      const senderName  = session.metadata?.sender_name || null;
      const senderEmail = session.metadata?.sender_email || null;
      const recipName   = session.metadata?.recipient_name || null;
      const recipEmail  = session.metadata?.recipient_email || null;
      const giftMsg     = session.metadata?.gift_message || null;
      const rawCode = generateCode();
      const norm = normalizeCode(rawCode);
      const codeHash = hashCode(norm);
      const codeLast4 = norm.slice(-4);
      const ins = await sql`
        INSERT INTO gift_cards (
          workspace_id, code_hash, code_last4,
          original_amount_cents, balance_cents,
          stripe_payment_intent,
          sender_name, sender_email, recipient_name, recipient_email, message,
          status
        ) VALUES (
          ${workspaceId}, ${codeHash}, ${codeLast4},
          ${amountCents}, ${amountCents},
          ${paymentIntentId},
          ${senderName}, ${senderEmail}, ${recipName}, ${recipEmail}, ${giftMsg},
          'active'
        )
        RETURNING *
      `;
      // Email the recipient with the raw code. We never store it —
      // this is the only moment it's available.
      try {
        if (recipEmail) {
          const branding = await fetchBranding(workspaceId);
          const business = branding.businessName || 'a friend';
          await sendEmail({
            to: recipEmail,
            subject: `You got a gift card from ${senderName || business}`,
            replyTo: branding.replyTo,
            html: emailShell({
              heading: `🎁 A gift card for you`,
              body: `<p>Hi ${escapeHtml(recipName || '')},</p>
                <p><strong>${escapeHtml(senderName || 'Someone')}</strong> sent you a gift card to spend with <strong>${escapeHtml(branding.businessName || 'us')}</strong>.</p>
                ${giftMsg ? `<blockquote style="margin:16px 0;padding:12px 16px;border-left:3px solid #C7BFA8;background:#F6F5F1;border-radius:6px;font-size:14px;line-height:1.55;color:#3F3D38;white-space:pre-wrap;">${escapeHtml(giftMsg)}</blockquote>` : ''}
                <p style="font-size:13px;color:#85827B;">Card balance:</p>
                <div style="font-size:28px;font-weight:600;font-family:Fraunces,Georgia,serif;letter-spacing:-0.02em;color:#141414;">$${(amountCents / 100).toFixed(2)}</div>
                <p style="font-size:13px;color:#85827B;margin-top:18px;">Your code:</p>
                <div style="font-family:ui-monospace,monospace;font-size:18px;font-weight:600;letter-spacing:0.04em;padding:10px 14px;background:#F6F5F1;border:1px solid #E8E4DC;border-radius:8px;display:inline-block;">${escapeHtml(rawCode)}</div>
                <p style="font-size:12px;color:#85827B;margin-top:18px;">Apply it on your booking page during checkout. Save this email — the code is shown only here.</p>`,
              ctaText: 'Visit booking page',
              ctaUrl: `${process.env.APP_URL || ''}`,
              footer: `Sent by ${escapeHtml(branding.businessName || 'a THRYVE business')}.`,
              branding,
            }),
          });
        }
      } catch (mailErr) {
        // eslint-disable-next-line no-console
        console.error('[webhook] gift card email failed:', mailErr.message);
      }
      notifyOwnerSafe({
        workspaceId,
        type: 'payments',
        payload: {
          title: '🎁 Gift card sold',
          body: `${senderName || 'Someone'} bought a $${(amountCents / 100).toFixed(2)} card for ${recipName || recipEmail || 'a recipient'}.`,
          url: '/finance',
          tag: `gc-${ins.rows[0].id}`,
        },
      });
      return ok(res, { received: true, marked: 'gift-card-issued' });
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
    // Record what the buyer was actually charged. With Stripe Tax off this
    // equals totals.total to the cent; with Stripe Tax on it includes the
    // Stripe-computed tax, matching the self-heal (markInvoicePaid) path.
    const paidAmount = Number.isFinite(session.amount_total)
      ? session.amount_total / 100
      : totals.total;
    const newActivity = [
      ...(inv.activity || []),
      {
        ts: new Date().toISOString(),
        kind: 'paid',
        text: `Paid by card · ${fmtMoney(paidAmount)}`,
      },
    ];

    // Capture payment_intent so the refund endpoint can target it
    // without re-fetching the session every time.
    const paymentIntent = typeof session.payment_intent === 'string'
      ? session.payment_intent
      : session.payment_intent?.id || null;

    const upd = await sql`
      UPDATE invoices SET
        status                 = 'paid',
        paid_at                = NOW(),
        paid_amount            = ${paidAmount},
        paid_method            = 'card',
        view_token_hash        = NULL,
        stripe_payment_intent  = ${paymentIntent},
        activity               = ${JSON.stringify(newActivity)}::jsonb,
        updated_at             = NOW()
      WHERE id = ${inv.id} AND workspace_id = ${workspaceId} AND status <> 'paid'
      RETURNING id
    `;
    // Lost a race with a concurrent webhook delivery (Stripe can fan a
    // single payment into checkout.session.completed + payment_intent.
    // succeeded for the same invoice, and each carries a different
    // event.id so markProcessed dedup doesn't catch them). Without
    // this guard we'd fire the owner push + client receipt email twice.
    // Mirrors the platform-webhook handler's pattern at lines 277-279.
    if (upd.rows.length === 0) {
      return ok(res, { received: true, ignored: 'already paid (race)' });
    }

    // Proactive Ivy hand-off: tap the push to land in Ivy with a
    // ready-to-go thank-you prompt. The /ivy?prompt= deep link is
    // consumed by IvyPro on mount — see the useEffect there.
    const clientLabel = inv.client_name || 'A client';
    const totalLabel  = fmtMoney(paidAmount);
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

    // Client receipt. Use paidAmount (what the buyer was actually
    // charged, including Stripe-Tax add-on) — not totals.total (which
    // is the invoice subtotal+tax_rate). For Stripe-Tax-enabled
    // workspaces the two differ. Best-effort — the race guard above
    // means this only fires when our UPDATE actually flipped status.
    notifyInvoicePaid({
      workspaceId, invoiceId: inv.id, totalAmount: paidAmount, method: 'card',
    });

    return ok(res, { received: true, marked: 'paid' });
  } catch (err) {
    // Processing threw after we claimed the event — release the claim so
    // Stripe's retry re-runs the handler rather than getting deduped.
    if (claimedEventId) await releaseProcessed('stripe', claimedEventId);
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
