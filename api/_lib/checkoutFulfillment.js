// Shared Stripe checkout fulfillment used by BOTH webhook endpoints:
//   • api/webhooks/stripe/[workspaceId].js  (legacy Standard-OAuth/BYO keys)
//   • api/webhooks/stripe-platform.js       (Account-Links / Express)
//
// Why shared: gift-card issuance used to live ONLY in the legacy webhook
// (so Express workspaces charged buyers and never issued the card), and
// storefront-order completion lived ONLY in the platform webhook (so
// legacy workspaces stranded paid orders in 'pending'). Each fulfillment
// now has exactly one implementation reachable from whichever endpoint
// the workspace's events actually arrive at. Both are idempotent.
import crypto from 'node:crypto';
import { sql } from './db.js';
import { generateCode, hashCode, normalizeCode } from './giftCards.js';
import { fetchBranding } from './branding.js';
import { sendEmail, sendEmailToUser, sendEmailToClient, sendEmailToClientByAddress, emailShell } from './email.js';
import { appUrl, generateRawToken } from './tokens.js';
import { notifyOwnerSafe } from './push.js';
import { markInvoicePaid } from './invoicePayments.js';
import { computeTotals } from './finance.js';
import { storeCardFromPaymentIntent } from './savedCards.js';
import { grantEnrollment, expiryFor } from './programs.js';
import { reportError } from './monitoring.js';

function fmtMoney(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Issue a gift card from a completed checkout session with
// metadata.purpose='gift_card'. Idempotent on the payment intent.
// Returns a small result object for the webhook's response body.
export async function issueGiftCardFromSession({ workspaceId, session }) {
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
      return { ignored: 'gift card already issued for this PI' };
    }
  }
  // The card is worth what the buyer paid. metadata.amount_cents is what
  // our checkout asked for; amount_total is what Stripe actually charged.
  // Fall back so a session minted without the metadata can never insert a
  // $0 card (CHECK violation → 500 → Stripe retries forever).
  const amountCents = Number(session.metadata?.amount_cents || 0)
    || Number(session.amount_total || 0);
  if (amountCents <= 0) return { ignored: 'gift card amount missing' };
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
  // Email the recipient with the raw code. We never store it -
  // this is the only moment it's available.
  try {
    if (recipEmail) {
      const branding = await fetchBranding(workspaceId);
      await sendEmail({
        to: recipEmail,
        subject: `You got a gift card from ${senderName || branding.businessName || 'a friend'}`,
        replyTo: branding.replyTo,
        html: emailShell({
          heading: `🎁 A gift card for you`,
          body: `<p>Hi ${escapeHtml(recipName || '')},</p>
            <p><strong>${escapeHtml(senderName || 'Someone')}</strong> sent you a gift card to spend with <strong>${escapeHtml(branding.businessName || 'us')}</strong>.</p>
            ${giftMsg ? `<blockquote style="margin:16px 0;padding:12px 16px;border-left:3px solid #C7BFA8;background:#F6F5F1;border-radius:6px;font-size:14px;line-height:1.55;color:#3F3D38;white-space:pre-wrap;">${escapeHtml(giftMsg)}</blockquote>` : ''}
            <p style="font-size:13px;color:#85827B;">Card balance:</p>
            <div style="font-size:28px;font-weight:600;font-family:'Neue Haas Grotesk Display','Helvetica Neue',Helvetica,Arial,sans-serif;letter-spacing:-0.02em;color:#141414;">$${(amountCents / 100).toFixed(2)}</div>
            <p style="font-size:13px;color:#85827B;margin-top:18px;">Your code:</p>
            <div style="font-family:ui-monospace,monospace;font-size:18px;font-weight:600;letter-spacing:0.04em;padding:10px 14px;background:#F6F5F1;border:1px solid #E8E4DC;border-radius:8px;display:inline-block;">${escapeHtml(rawCode)}</div>
            <p style="font-size:12px;color:#85827B;margin-top:18px;">Apply it on your booking page during checkout. Save this email - the code is shown only here.</p>`,
          ctaText: 'Visit booking page',
          ctaUrl: appUrl(),
          footer: `Sent by ${escapeHtml(branding.businessName || 'an Ivy business')}.`,
          branding,
        }),
      });
    }
  } catch (mailErr) {
    // eslint-disable-next-line no-console
    console.error('[fulfillment] gift card email failed:', mailErr.message);
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
  return { marked: 'gift-card-issued' };
}

// Mark a storefront order paid + decrement tracked stock, from a
// succeeded payment intent carrying metadata.order_id. Idempotent:
// the UPDATE only matches status='pending'.
export async function markOrderPaidFromPI({ workspaceId, pi }) {
  const orderId = pi.metadata?.order_id;
  if (!orderId) return { ignored: 'no order_id' };
  const upd = await sql`
    UPDATE orders
       SET status = 'paid', paid_at = NOW(),
           stripe_payment_intent = ${pi.id}, updated_at = NOW()
     WHERE id = ${orderId} AND workspace_id = ${workspaceId}
       AND status = 'pending'
     RETURNING items, total, customer_name, customer_email, client_id
  `;
  if (upd.rows.length === 0) {
    return { ignored: 'order already paid or not found' };
  }
  const o = upd.rows[0];
  const items = Array.isArray(o.items) ? o.items : [];
  for (const it of items) {
    await sql`
      UPDATE products SET stock_qty = GREATEST(0, stock_qty - ${Number(it.qty || 0)})
       WHERE id = ${it.productId} AND workspace_id = ${workspaceId}
         AND track_stock = TRUE
    `;
  }
  notifyOwnerSafe({
    workspaceId, type: 'payments',
    payload: {
      title: 'Order paid 💸',
      body: `${o.customer_name} · $${Number(o.total).toFixed(2)}`,
      url: '/finance',
      tag: `order-paid-${orderId}`,
    },
  });
  return { applied: 'order-paid' };
}

// ─────────────────────────────────────────────────────────────────────
// Checkout session fulfilment (shared by both Stripe webhooks)
// ─────────────────────────────────────────────────────────────────────
//
// Stripe's dynamic payment methods mean a client can now pay an invoice by
// ACH Direct Debit. For those, checkout.session.completed arrives with
// payment_status 'unpaid' - the debit was authorised, the money settles up
// to 4 business days later, and Stripe then sends
// checkout.session.async_payment_succeeded (or _failed). Nothing below
// fulfils anything unless payment_status === 'paid'; an unpaid invoice
// session is stamped "payment processing" instead.

const DELAYED_METHODS = new Set(['us_bank_account', 'sepa_debit', 'bacs_debit', 'au_becs_debit', 'acss_debit', 'boleto', 'oxxo', 'konbini']);

export function isPaidSession(session) {
  return session?.payment_status === 'paid';
}

// 'unpaid' on a complete session = a delayed method still settling.
export function isPendingSession(session) {
  return session?.status === 'complete' && session?.payment_status === 'unpaid';
}

function sessionPaymentIntentId(session) {
  return typeof session?.payment_intent === 'string'
    ? session.payment_intent : session?.payment_intent?.id || null;
}

// Best guess at the paid_method value for a Checkout session: 'ach' when
// the only offered method was a bank debit (or the PI used one), else card.
export function paidMethodForSession(session, pi = null) {
  const types = Array.isArray(session?.payment_method_types) ? session.payment_method_types : [];
  const piType = pi?.payment_method_types?.[0] || pi?.charges?.data?.[0]?.payment_method_details?.type || null;
  if (piType && DELAYED_METHODS.has(piType)) return 'ach';
  if (types.length > 0 && types.every((t) => DELAYED_METHODS.has(t))) return 'ach';
  // A complete-but-unpaid session can only be a delayed method: cards
  // settle instantly, so 'unpaid' at completion means the bank debit.
  if (isPendingSession(session) && types.some((t) => DELAYED_METHODS.has(t))) return 'ach';
  return 'card';
}

// Saved-card follow-through for a paid invoice session / PI that asked for
// setup_future_usage. Best-effort; never blocks the payment landing.
async function maybeStoreSavedCard({ creds, workspaceId, metadata, paymentIntentId, customerId }) {
  if (!creds || metadata?.save_card !== '1' || !metadata?.client_id || !paymentIntentId) return null;
  try {
    return await storeCardFromPaymentIntent({
      creds, workspaceId, clientId: metadata.client_id, paymentIntentId, customerId,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[fulfillment] saving card failed (payment still landed):', err.message);
    return null;
  }
}

// payment_intent.succeeded safety net + off-session saved-card charges land
// here. Idempotent via markInvoicePaid (UPDATE guarded by status<>'paid').
export async function fulfillInvoicePaymentIntent({ workspaceId, pi, creds = null, method = null }) {
  const invoiceId = pi?.metadata?.invoice_id;
  if (!invoiceId) return 'invoice-not-found';
  let resolved = method || paidMethodForSession(null, pi);
  if (!method && resolved === 'card') {
    const prev = await sql`SELECT payment_processing_method FROM invoices WHERE id = ${invoiceId} AND workspace_id = ${workspaceId}`;
    if (prev.rows[0]?.payment_processing_method) resolved = prev.rows[0].payment_processing_method;
  }
  const result = await markInvoicePaid({
    workspaceId, invoiceId, paymentIntent: pi.id,
    amountCents: pi.amount_received ?? pi.amount,
    method: resolved,
  });
  if (result === 'paid') {
    await maybeStoreSavedCard({
      creds, workspaceId, metadata: pi.metadata, paymentIntentId: pi.id,
      customerId: typeof pi.customer === 'string' ? pi.customer : pi.customer?.id || null,
    });
  }
  return result;
}

// A PAID invoice Checkout session (card now, or ACH that just settled).
// settledAsync = the webhook knows this is async_payment_succeeded; otherwise
// a "payment processing" stamp from the earlier unpaid completion tells us
// the money came by bank debit.
export async function fulfillInvoiceCheckoutSession({ workspaceId, session, creds = null, settledAsync = false }) {
  const invoiceId = session?.metadata?.invoice_id;
  if (!invoiceId) return 'invoice-not-found';
  if (!isPaidSession(session)) return 'not-paid';
  const paymentIntent = sessionPaymentIntentId(session);
  let method = paidMethodForSession(session);
  if (method === 'card') {
    const prev = await sql`SELECT payment_processing_method FROM invoices WHERE id = ${invoiceId} AND workspace_id = ${workspaceId}`;
    if (prev.rows[0]?.payment_processing_method) method = prev.rows[0].payment_processing_method;
    else if (settledAsync) method = 'ach';
  }
  const result = await markInvoicePaid({
    workspaceId, invoiceId, paymentIntent,
    amountCents: session.amount_total,
    method,
    sessionId: session.id || null,
  });
  if (result === 'paid') {
    await maybeStoreSavedCard({
      creds, workspaceId, metadata: session.metadata, paymentIntentId: paymentIntent,
      customerId: typeof session.customer === 'string' ? session.customer : session.customer?.id || null,
    });
  }
  return result;
}

// Delayed method authorised, money not yet settled. Stamp the invoice (it
// stays 'sent'/'overdue'), add an activity line the owner's drawer shows
// as "Payment processing", and tell the owner once. Idempotent: the UPDATE
// only fires while the stamp is empty.
export async function markInvoiceProcessing({ workspaceId, invoiceId, session }) {
  const { rows } = await sql`
    SELECT id, number, client_id, client_name, items, tax_rate, discount, activity, status, payment_processing_at
      FROM invoices WHERE id = ${invoiceId} AND workspace_id = ${workspaceId}
  `;
  const inv = rows[0];
  if (!inv) return 'invoice-not-found';
  if (inv.status === 'paid' || inv.status === 'refunded') return 'already-paid';
  if (inv.payment_processing_at) return 'already-processing';
  const method = paidMethodForSession(session);
  const totals = computeTotals(inv.items || [], inv.tax_rate, inv.discount);
  const amount = Number.isFinite(session?.amount_total) ? session.amount_total / 100 : totals.total;
  const activity = [
    ...(inv.activity || []),
    { ts: new Date().toISOString(), kind: 'payment-processing',
      text: `Bank payment started · ${fmtMoney(amount)} · usually clears within 4 business days` },
  ];
  const upd = await sql`
    UPDATE invoices SET
      payment_processing_at     = NOW(),
      payment_processing_method = ${method},
      stripe_session_id         = COALESCE(${session?.id || null}, stripe_session_id),
      stripe_payment_intent     = COALESCE(${sessionPaymentIntentId(session)}, stripe_payment_intent),
      activity                  = ${JSON.stringify(activity)}::jsonb,
      updated_at                = NOW()
    WHERE id = ${invoiceId} AND workspace_id = ${workspaceId}
      AND status IN ('sent', 'overdue') AND payment_processing_at IS NULL
    RETURNING id
  `;
  if (upd.rows.length === 0) return 'already-processing';

  notifyOwnerSafe({
    workspaceId, type: 'payments',
    payload: {
      title: 'Bank payment on its way',
      body: `${inv.client_name || 'A client'} · ${inv.number} · ${fmtMoney(amount)}. Usually clears within 4 business days.`,
      url: `/finance?invoice=${invoiceId}`,
      tag: `invoice-processing-${invoiceId}`,
    },
  });
  notifyOwnerProcessing({ workspaceId, inv, amount }).catch(() => {});
  return 'processing';
}

async function ownerFor(workspaceId) {
  const { rows } = await sql`
    SELECT w.owner_id, u.email, u.name FROM workspaces w
    LEFT JOIN users u ON u.id = w.owner_id WHERE w.id = ${workspaceId}
  `;
  return rows[0] || null;
}

async function notifyOwnerProcessing({ workspaceId, inv, amount }) {
  try {
    const owner = await ownerFor(workspaceId);
    if (!owner?.email) return;
    const branding = await fetchBranding(workspaceId);
    const greeting = owner.name ? `Hi ${escapeHtml(owner.name.split(/\s+/)[0])},` : 'Hi,';
    await sendEmailToUser({
      userId: owner.owner_id, type: 'invoices', to: owner.email,
      subject: `Bank payment started - ${inv.number} · ${fmtMoney(amount)}`,
      html: emailShell({
        heading: 'A bank payment is on its way',
        branding,
        body: `<p>${greeting}</p>
          <p><strong>${escapeHtml(inv.client_name || 'A client')}</strong> paid invoice <strong>${escapeHtml(inv.number)}</strong> (${fmtMoney(amount)}) by bank debit.</p>
          <p>Bank payments usually clear within 4 business days. The invoice shows as <strong>Payment processing</strong> until then, and it will be marked paid on its own once the money lands. If the debit fails, you and your client both hear about it.</p>`,
        ctaText: 'Open the invoice',
        ctaUrl: `${appUrl()}/finance?invoice=${inv.id}`,
        footer: 'You are getting this because a client started a bank payment on one of your invoices.',
      }),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[fulfillment] owner processing email failed:', err.message);
  }
}

// Recover the raw invoice view token from the Checkout success_url
// (…/invoice/<token>?paid=1) when it still matches the stored hash, so the
// "try again" link in the failure email is the one the client already has.
// Otherwise mint a fresh token (and invalidate the old link).
async function ensurePayLink(inv, session) {
  const m = String(session?.success_url || '').match(/\/invoice\/([A-Za-z0-9_-]{16,})/);
  if (m && inv.view_token_hash) {
    const hash = crypto.createHash('sha256').update(m[1]).digest('hex');
    if (hash === inv.view_token_hash) return `${appUrl()}/invoice/${encodeURIComponent(m[1])}`;
  }
  const raw = generateRawToken(32);
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  await sql`
    UPDATE invoices SET view_token_hash = ${hash}, updated_at = NOW()
     WHERE id = ${inv.id} AND workspace_id = ${inv.workspace_id} AND status IN ('sent', 'overdue')
  `;
  return `${appUrl()}/invoice/${encodeURIComponent(raw)}`;
}

// checkout.session.async_payment_failed for an invoice: the debit bounced.
// Leave the invoice unpaid, clear the processing stamp, note it, tell the
// owner, and email the client a link to pay again. Idempotent per session.
export async function failInvoiceAsyncPayment({ workspaceId, session }) {
  const invoiceId = session?.metadata?.invoice_id;
  if (!invoiceId) return 'invoice-not-found';
  const { rows } = await sql`
    SELECT * FROM invoices WHERE id = ${invoiceId} AND workspace_id = ${workspaceId}
  `;
  const inv = rows[0];
  if (!inv) return 'invoice-not-found';
  if (inv.status === 'paid' || inv.status === 'refunded') return 'already-paid';
  const already = (inv.activity || []).some((a) => a.kind === 'payment-failed' && a.sessionId === session.id);
  if (already) return 'already-recorded';
  const totals = computeTotals(inv.items || [], inv.tax_rate, inv.discount);
  const amount = Number.isFinite(session?.amount_total) ? session.amount_total / 100 : totals.total;
  const activity = [
    ...(inv.activity || []),
    { ts: new Date().toISOString(), kind: 'payment-failed', sessionId: session.id || null,
      text: `Bank payment failed · ${fmtMoney(amount)} · the client was asked to pay again` },
  ];
  const upd = await sql`
    UPDATE invoices SET
      payment_processing_at     = NULL,
      payment_processing_method = NULL,
      activity                  = ${JSON.stringify(activity)}::jsonb,
      updated_at                = NOW()
    WHERE id = ${invoiceId} AND workspace_id = ${workspaceId} AND status IN ('sent', 'overdue')
    RETURNING id
  `;
  if (upd.rows.length === 0) return 'already-paid';

  notifyOwnerSafe({
    workspaceId, type: 'payments',
    payload: {
      title: 'Bank payment failed',
      body: `${inv.client_name || 'A client'} · ${inv.number} · ${fmtMoney(amount)}. We asked them to pay again.`,
      url: `/finance?invoice=${invoiceId}`,
      tag: `invoice-failed-${invoiceId}`,
    },
  });
  try {
    const branding = await fetchBranding(workspaceId);
    const business = branding.businessName || 'the business';
    const owner = await ownerFor(workspaceId);
    if (owner?.email) {
      await sendEmailToUser({
        userId: owner.owner_id, type: 'invoices', to: owner.email,
        subject: `Bank payment failed - ${inv.number} · ${fmtMoney(amount)}`,
        html: emailShell({
          heading: 'A bank payment did not go through',
          branding,
          body: `<p>${owner.name ? `Hi ${escapeHtml(owner.name.split(/\s+/)[0])},` : 'Hi,'}</p>
            <p>The bank debit <strong>${escapeHtml(inv.client_name || 'your client')}</strong> started for invoice <strong>${escapeHtml(inv.number)}</strong> (${fmtMoney(amount)}) was returned by their bank. The invoice is still open.</p>
            <p>We have emailed them a link to pay again. No action is needed from you unless they get in touch.</p>`,
          ctaText: 'Open the invoice',
          ctaUrl: `${appUrl()}/finance?invoice=${inv.id}`,
          footer: 'You are getting this because a bank payment on one of your invoices failed.',
        }),
      });
    }
    if (inv.client_email) {
      const payUrl = await ensurePayLink(inv, session);
      const html = emailShell({
        heading: 'Your bank payment did not go through',
        branding,
        body: `<p>Hi ${escapeHtml((inv.client_name || '').split(/\s+/)[0] || 'there')},</p>
          <p>The bank payment of <strong>${fmtMoney(amount)}</strong> for invoice <strong>${escapeHtml(inv.number)}</strong> from <strong>${escapeHtml(business)}</strong> was returned by your bank, so the invoice is still unpaid.</p>
          <p>Nothing was taken from your account. You can try again with the same bank account or pay by card using the button below.</p>`,
        ctaText: 'Pay this invoice',
        ctaUrl: payUrl,
        footer: `Questions about this invoice? Reply to this email to reach ${escapeHtml(business)}.`,
      });
      const common = { type: 'invoices', subject: `Payment failed for invoice ${inv.number} - please try again`, html, replyTo: branding.replyTo };
      if (inv.client_id) await sendEmailToClient({ clientId: inv.client_id, to: inv.client_email, ...common });
      else await sendEmailToClientByAddress({ workspaceId, email: inv.client_email, ...common });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[fulfillment] async-failed notifications failed:', err.message);
    reportError(err, { extra: { invoiceId, workspaceId } });
  }
  return 'failed-recorded';
}

// Booking deposit from a paid session (metadata.invoice_id 'bookdep_<id>',
// or the legacy forward pointer bookings.deposit_payment_intent = session
// id). Idempotent: only applies while deposit_paid_at is empty.
async function fulfillDepositSession({ workspaceId, session }) {
  const invoiceId = session?.metadata?.invoice_id;
  const paymentIntent = sessionPaymentIntentId(session);
  let bookingId = invoiceId && String(invoiceId).startsWith('bookdep_') ? invoiceId.slice('bookdep_'.length) : null;
  if (!bookingId && session?.id) {
    const { rows } = await sql`
      SELECT id FROM bookings WHERE workspace_id = ${workspaceId} AND deposit_payment_intent = ${session.id} LIMIT 1
    `;
    bookingId = rows[0]?.id || null;
  }
  if (!bookingId) return { ignored: 'no booking for deposit session' };
  const dep = await sql`
    UPDATE bookings SET
      deposit_paid = deposit_required,
      deposit_paid_at = NOW(),
      deposit_payment_intent = ${paymentIntent},
      updated_at = NOW()
    WHERE id = ${bookingId} AND workspace_id = ${workspaceId}
      AND deposit_paid_at IS NULL
    RETURNING id
  `;
  if (dep.rows.length === 0) return { ignored: 'deposit already recorded' };
  notifyOwnerSafe({
    workspaceId, type: 'bookings',
    payload: { title: 'Deposit paid', body: `Booking deposit for ${String(bookingId).slice(0, 8)} just came in.`,
      url: '/calendar', tag: `deposit-${bookingId}` },
  });
  return { applied: 'booking-deposit', bookingId };
}

async function fulfillProgramSession({ workspaceId, session }) {
  const programId = session.metadata?.program_id;
  const clientId = session.metadata?.client_id;
  if (!programId || !clientId) return { ignored: 'program metadata incomplete' };
  const prog = (await sql`SELECT id, billing, price_cents, access_days FROM programs WHERE id = ${programId} AND workspace_id = ${workspaceId}`).rows[0];
  const cli = (await sql`SELECT id FROM clients WHERE id = ${clientId} AND workspace_id = ${workspaceId}`).rows[0];
  if (!prog || !cli) return { ignored: 'program or client not found' };
  const already = (await sql`SELECT id FROM program_enrollments WHERE stripe_session_id = ${session.id}`).rows[0];
  if (already) return { applied: 'program-purchase', duplicate: true };
  await grantEnrollment({ programId, workspaceId, clientId, source: 'purchase', billing: 'one_time', priceCents: prog.price_cents, stripeSessionId: session.id, expiresAt: expiryFor(prog) });
  return { applied: 'program-purchase' };
}

async function fulfillPackageSession({ workspaceId, session }) {
  const packageId = session.metadata?.package_id;
  const clientId  = session.metadata?.client_id;
  if (!packageId || !clientId) return { ignored: 'package metadata incomplete' };
  const dup = await sql`
    SELECT id FROM client_packages WHERE workspace_id = ${workspaceId} AND stripe_session_id = ${session.id} LIMIT 1
  `;
  if (dup.rows.length > 0) return { ignored: 'package already provisioned' };
  const pkg = await sql`
    SELECT id, name, service_ids, session_count, price, expiry_days FROM packages
     WHERE id = ${packageId} AND workspace_id = ${workspaceId}
  `;
  if (pkg.rows.length === 0) return { ignored: 'package not found' };
  const p = pkg.rows[0];
  const credits = Math.max(1, Number(p.session_count) || 1);
  const priceCharged = Number.isFinite(session.amount_total) ? session.amount_total / 100 : Number(p.price || 0);
  const expiresAt = p.expiry_days ? new Date(Date.now() + Number(p.expiry_days) * 86400 * 1000) : null;
  const paymentIntentId = typeof session.payment_intent === 'string'
    ? session.payment_intent : session.payment_intent?.id || null;
  try {
    await sql`
      INSERT INTO client_packages (
        workspace_id, client_id, package_id, name, service_ids,
        credits_total, credits_remaining, price, expires_at, status,
        stripe_session_id, stripe_payment_intent
      ) VALUES (
        ${workspaceId}, ${clientId}, ${p.id}, ${p.name}, ${p.service_ids || []},
        ${credits}, ${credits}, ${priceCharged}, ${expiresAt}, 'active',
        ${session.id}, ${paymentIntentId}
      )
    `;
  } catch (err) {
    // Two deliveries of the same session racing past the SELECT above:
    // the unique index on stripe_session_id makes the loser a no-op
    // instead of a 500 that Stripe would keep retrying.
    if (err?.code === '23505') return { ignored: 'package already provisioned' };
    throw err;
  }
  notifyOwnerSafe({
    workspaceId, type: 'payments',
    payload: { title: 'Package sold 🎟️', body: `${p.name} (${credits} sessions) - $${priceCharged.toFixed(0)}`,
      url: '/clients', tag: `package-${session.id}` },
  });
  return { applied: 'package-provisioned' };
}

// The one dispatcher both webhooks call for a mode='payment' Checkout
// session, on checkout.session.completed AND on
// checkout.session.async_payment_succeeded. Nothing is fulfilled unless the
// session is paid; an unpaid invoice session becomes "payment processing".
// Every branch is idempotent, so the paired delivery (completed with
// payment_status 'paid' plus a later async event, or a Stripe retry) is a
// no-op the second time.
export async function fulfillCheckoutSession({ workspaceId, session, creds = null, settledAsync = false }) {
  if (!session || session.mode !== 'payment') return { ignored: `mode=${session?.mode || 'unknown'}` };
  const purpose = session.metadata?.purpose || null;
  const invoiceId = session.metadata?.invoice_id || null;
  const isDeposit = (invoiceId && String(invoiceId).startsWith('bookdep_')) || (!invoiceId && !purpose);

  if (!isPaidSession(session)) {
    if (invoiceId && !isDeposit && !purpose) {
      const r = await markInvoiceProcessing({ workspaceId, invoiceId, session });
      return { applied: 'invoice-processing', result: r };
    }
    return { ignored: `payment_status=${session.payment_status || 'unknown'} - awaiting settlement` };
  }

  if (purpose === 'gift_card') return issueGiftCardFromSession({ workspaceId, session });
  if (purpose === 'program')   return fulfillProgramSession({ workspaceId, session });
  if (purpose === 'package')   return fulfillPackageSession({ workspaceId, session });
  if (isDeposit) {
    const r = await fulfillDepositSession({ workspaceId, session });
    if (!invoiceId && r.ignored === 'no booking for deposit session') return { ignored: 'no metadata' };
    return r;
  }
  const result = await fulfillInvoiceCheckoutSession({ workspaceId, session, creds, settledAsync });
  return { applied: 'invoice-paid', result };
}

// charge.refunded for a purchase that has no invoice row: a gift card or a
// package bought from the public booking page and refunded from the
// payment dashboard (or by a dispute). Without this the recipient keeps
// spending a card the owner already gave the money back for, and the
// client keeps booking on refunded credits. Shared by both webhooks.
//
// charge.amount_refunded is CUMULATIVE cents, so every branch is
// idempotent on an exact re-delivery and only applies the new delta on a
// second partial refund. Returns { applied } or { ignored } for the
// webhook's response body.
export async function syncRefundToPurchases({ workspaceId, charge }) {
  const pi = typeof charge?.payment_intent === 'string'
    ? charge.payment_intent : charge?.payment_intent?.id || null;
  if (!pi) return { ignored: 'no payment_intent on charge' };
  const refundedCents = Math.max(0, Math.round(Number(charge.amount_refunded || 0)));
  const chargedCents  = Math.max(0, Math.round(Number(charge.amount || 0)));
  const fully = chargedCents > 0 && refundedCents >= chargedCents;

  // Gift card: take the newly refunded cents off the balance; a full
  // refund voids the card outright so findActiveByCode never matches it.
  const card = (await sql`
    SELECT id, balance_cents, refunded_cents, status, code_last4
      FROM gift_cards
     WHERE workspace_id = ${workspaceId} AND stripe_payment_intent = ${pi}
     LIMIT 1
  `).rows[0];
  if (card) {
    const already = Number(card.refunded_cents || 0);
    if (refundedCents <= already) return { ignored: 'refund already recorded' };
    const delta = refundedCents - already;
    // Every RHS reference to balance_cents is the pre-update value, so the
    // status flip and the new balance agree.
    const upd = await sql`
      UPDATE gift_cards SET
        balance_cents  = CASE WHEN ${fully} THEN 0 ELSE GREATEST(0, balance_cents - ${delta}) END,
        refunded_cents = ${refundedCents},
        status         = CASE WHEN ${fully} OR balance_cents - ${delta} <= 0 THEN 'voided' ELSE status END,
        updated_at     = NOW()
      WHERE id = ${card.id} AND workspace_id = ${workspaceId}
        AND refunded_cents = ${already}
      RETURNING balance_cents, status
    `;
    if (upd.rows.length === 0) return { ignored: 'refund already recorded' };
    const left = Number(upd.rows[0].balance_cents);
    notifyOwnerSafe({
      workspaceId, type: 'payments',
      payload: {
        title: fully ? 'Gift card refunded' : 'Gift card partly refunded',
        body: `Card …${card.code_last4}: ${fmtMoney(delta / 100)} refunded${fully ? '; the card is now void.' : `; ${fmtMoney(left / 100)} left on it.`}`,
        url: '/finance?section=giftcards',
        tag: `gc-refund-${card.id}`,
      },
    });
    return { applied: 'gift-card-refund-synced', fully, balanceCents: left };
  }

  // Package: a full refund cancels the bundle. A partial refund is left
  // to the owner (they can trim credits from the client's page); the
  // push tells them it happened.
  const cp = (await sql`
    SELECT id, name, client_id, status, credits_remaining
      FROM client_packages
     WHERE workspace_id = ${workspaceId} AND stripe_payment_intent = ${pi}
     LIMIT 1
  `).rows[0];
  if (cp) {
    if (!fully) {
      notifyOwnerSafe({
        workspaceId, type: 'payments',
        payload: {
          title: 'Package partly refunded',
          body: `${cp.name}: ${fmtMoney(refundedCents / 100)} refunded. Adjust the client's remaining sessions if needed.`,
          url: `/clients?id=${encodeURIComponent(cp.client_id)}`,
          tag: `pkg-refund-${cp.id}`,
        },
      });
      return { applied: 'package-refund-noted', fully: false };
    }
    const upd = await sql`
      UPDATE client_packages SET status = 'cancelled', credits_remaining = 0, updated_at = NOW()
       WHERE id = ${cp.id} AND workspace_id = ${workspaceId} AND status <> 'cancelled'
       RETURNING id
    `;
    if (upd.rows.length === 0) return { ignored: 'refund already recorded' };
    const n = Number(cp.credits_remaining || 0);
    notifyOwnerSafe({
      workspaceId, type: 'payments',
      payload: {
        title: 'Package refunded',
        body: `${cp.name} was refunded in full; its ${n} remaining session${n === 1 ? '' : 's'} were cancelled.`,
        url: `/clients?id=${encodeURIComponent(cp.client_id)}`,
        tag: `pkg-refund-${cp.id}`,
      },
    });
    return { applied: 'package-refund-synced', fully: true };
  }
  return { ignored: 'no purchase for payment_intent' };
}
