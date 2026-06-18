// POST /api/gift-cards/checkout (public, no auth)
//   body: { slug, amountCents, senderName, senderEmail,
//           recipientName, recipientEmail, message? }
//
// Mints a Stripe Checkout session for a gift-card purchase on the
// workspace's connected account. The code itself is generated on
// webhook completion (so we don't issue an unredeemable code if
// payment ultimately fails).
import { sql } from '../_lib/db.js';
import { readBody } from '../_lib/body.js';
import { enforce, getClientIp } from '../_lib/rate-limit.js';
import { validEmail } from '../_lib/auth.js';
import { loadStripeCreds } from '../_lib/stripeCreds.js';
import { appUrl } from '../_lib/tokens.js';
import { badRequest, methodNotAllowed, notFound, ok, serverError } from '../_lib/json.js';

async function stripeCheckout({ secretKey, stripeAccount }, body) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) params.set(k, String(v));
  const headers = {
    Authorization: `Bearer ${secretKey}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (stripeAccount) headers['Stripe-Account'] = stripeAccount;
  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers,
    body: params.toString(),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error?.message || 'Stripe error');
  return j;
}

const ALLOWED_AMOUNTS_CENTS = new Set([2500, 5000, 7500, 10000, 15000, 20000, 25000, 50000, 100000]);

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try {
    const ip = getClientIp(req);
    const blocked = await enforce(req, res, [
      { key: `gc-buy:ip:${ip}`, max: 10, windowSeconds: 60 * 60 },
    ]);
    if (blocked) return;

    const body = await readBody(req);
    const slug = (body.slug || '').toString().toLowerCase().trim();
    const amountCents = Number.isInteger(body.amountCents)
      ? body.amountCents : Math.round(Number(body.amountCents || 0));
    const senderName  = (body.senderName  || '').toString().trim().slice(0, 200);
    const senderEmail = (body.senderEmail || '').toString().trim().toLowerCase().slice(0, 200);
    const recipientName  = (body.recipientName  || '').toString().trim().slice(0, 200);
    const recipientEmail = (body.recipientEmail || '').toString().trim().toLowerCase().slice(0, 200);
    const message = body.message ? String(body.message).slice(0, 1000) : null;

    if (!slug) return badRequest(res, 'slug is required');
    // Allow custom amounts but cap them to prevent stress-testing.
    if (!Number.isInteger(amountCents) || amountCents < 500 || amountCents > 1_000_000) {
      return badRequest(res, 'amountCents must be between $5 and $10,000');
    }
    if (!ALLOWED_AMOUNTS_CENTS.has(amountCents)) {
      // For safety we limit to a fixed ladder. If business owners
      // want truly custom amounts later we can lift this with their
      // explicit configuration.
      return badRequest(res, 'Pick one of the listed amounts');
    }
    if (!senderName)  return badRequest(res, 'Your name is required.');
    if (!validEmail(senderEmail))    return badRequest(res, 'A valid sender email is required.');
    if (!recipientName) return badRequest(res, "Recipient name is required.");
    if (!validEmail(recipientEmail)) return badRequest(res, 'A valid recipient email is required.');

    const cs = await sql`SELECT workspace_id FROM calendar_settings WHERE slug = ${slug}`;
    if (cs.rows.length === 0) return notFound(res, 'No business with that handle');
    const workspaceId = cs.rows[0].workspace_id;

    // Gift-card sales are Stripe-only by design (hosted Checkout). Square/
    // PayPal aren't wired for selling gift cards - surface that plainly
    // rather than a generic "card payments" message.
    let creds;
    try { creds = await loadStripeCreds(workspaceId); }
    catch (e) {
      return badRequest(res, e.code === 'no_stripe_connection'
        ? 'Gift cards require Stripe. Connect Stripe in Finance to sell them (Square/PayPal aren’t supported for gift cards yet).'
        : e.message);
    }

    const base = appUrl();
    // Pass everything the webhook needs as metadata. We delay code
    // generation until payment completes - if Stripe declines, we
    // never issue an unredeemable code.
    const session = await stripeCheckout({
      secretKey:     creds.secretKey,
      stripeAccount: creds.stripeAccount,
    }, {
      mode: 'payment',
      success_url: `${base}/book/${encodeURIComponent(slug)}?giftcard=ok`,
      cancel_url:  `${base}/book/${encodeURIComponent(slug)}?giftcard=cancel`,
      customer_email: senderEmail,
      'line_items[0][price_data][currency]': creds.currency.toLowerCase(),
      'line_items[0][price_data][unit_amount]': String(amountCents),
      'line_items[0][price_data][product_data][name]': `Gift card`,
      'line_items[0][quantity]': '1',
      'metadata[purpose]': 'gift_card',
      'metadata[workspace_id]': workspaceId,
      'metadata[amount_cents]': String(amountCents),
      'metadata[sender_name]': senderName,
      'metadata[sender_email]': senderEmail,
      'metadata[recipient_name]': recipientName,
      'metadata[recipient_email]': recipientEmail,
      ...(message ? { 'metadata[gift_message]': message } : {}),
    });
    return ok(res, { url: session.url });
  } catch (err) {
    return serverError(res, err);
  }
}
