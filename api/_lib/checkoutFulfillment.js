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
import { sql } from './db.js';
import { generateCode, hashCode, normalizeCode } from './giftCards.js';
import { fetchBranding } from './branding.js';
import { sendEmail, emailShell } from './email.js';
import { appUrl } from './tokens.js';
import { notifyOwnerSafe } from './push.js';

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
            <div style="font-size:28px;font-weight:600;font-family:Fraunces,Georgia,serif;letter-spacing:-0.02em;color:#141414;">$${(amountCents / 100).toFixed(2)}</div>
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
