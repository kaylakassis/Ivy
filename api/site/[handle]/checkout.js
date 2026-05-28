// POST /api/site/:handle/checkout  (public, no auth)
//   body: { items: [{ productId, qty }], customer: { name, email } }
//
// Creates a pending orders row, then mints a Stripe Checkout Session
// against the workspace's connected account. metadata.order_id +
// workspace_id let the existing platform webhook resolve payment_
// intent.succeeded back to this order without any new dispatcher code.
//
// Public + rate-limited per IP because checkout creates DB rows.
import { sql } from '../../_lib/db.js';
import { readBody } from '../../_lib/body.js';
import { enforce, getClientIp } from '../../_lib/rate-limit.js';
import { loadStripeCreds } from '../../_lib/stripeCreds.js';
import { appUrl } from '../../_lib/tokens.js';
import { badRequest, methodNotAllowed, notFound, ok, serverError } from '../../_lib/json.js';

function fetchTimeout(url, opts, ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return fetch(url, { ...opts, signal: c.signal }).finally(() => clearTimeout(t));
}

function validEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try {
    const handle = (req.query.handle || '').toString().toLowerCase();
    if (!handle) return notFound(res);

    const ip = getClientIp(req);
    const blocked = await enforce(req, res, [
      { key: `shop:ip:${ip}`, max: 20, windowSeconds: 60 * 60 },
    ]);
    if (blocked) return;

    const body = await readBody(req);
    const itemsIn = Array.isArray(body.items) ? body.items : [];
    const customer = body.customer || {};
    const customerName = String(customer.name || '').trim().slice(0, 200);
    const customerEmail = String(customer.email || '').trim().toLowerCase().slice(0, 200);
    if (!customerName) return badRequest(res, 'Your name is required.');
    if (!validEmail(customerEmail)) return badRequest(res, 'A valid email is required.');
    if (itemsIn.length === 0) return badRequest(res, 'Your cart is empty.');

    // Resolve workspace by website handle.
    const w = await sql`
      SELECT workspace_id FROM websites WHERE handle = ${handle}
        AND published_at IS NOT NULL
       LIMIT 1
    `;
    if (w.rows.length === 0) return notFound(res, 'No shop at that handle');
    const workspaceId = w.rows[0].workspace_id;

    // Validate every productId belongs to this workspace + is active +
    // (if tracked) in stock for the requested qty.
    const productIds = itemsIn
      .map((it) => String(it.productId || ''))
      .filter(Boolean)
      .slice(0, 50);
    if (productIds.length === 0) return badRequest(res, 'Cart had no valid items.');

    const r = await sql.query(
      `SELECT id, name, price, track_stock, stock_qty, active
         FROM products
        WHERE workspace_id = $1 AND id = ANY($2::uuid[])`,
      [workspaceId, productIds],
    );
    const byId = new Map(r.rows.map((p) => [p.id, p]));

    const items = [];
    let subtotal = 0;
    for (const it of itemsIn) {
      const p = byId.get(String(it.productId));
      if (!p || !p.active) {
        return badRequest(res, `An item in your cart is no longer available.`);
      }
      const qty = Math.max(1, Math.min(100, Number.parseInt(it.qty, 10) || 1));
      if (p.track_stock && Number(p.stock_qty) < qty) {
        return badRequest(res, `Sorry, "${p.name}" only has ${p.stock_qty} left.`);
      }
      const rate = Number(p.price || 0);
      items.push({ productId: p.id, name: p.name, qty, rate });
      subtotal += rate * qty;
    }
    subtotal = Math.round(subtotal * 100) / 100;
    const tax = 0;
    const total = subtotal + tax;

    // Find-or-create a clients row by email — same pattern the
    // membership checkout uses so the order links to a client profile.
    let clientId = null;
    try {
      const existing = await sql`
        SELECT id FROM clients
         WHERE workspace_id = ${workspaceId} AND email = ${customerEmail}
         LIMIT 1
      `;
      if (existing.rows.length > 0) {
        clientId = existing.rows[0].id;
      } else {
        const ins = await sql`
          INSERT INTO clients (workspace_id, name, email, stage, source)
          VALUES (${workspaceId}, ${customerName}, ${customerEmail}, 'active', 'shop')
          RETURNING id
        `;
        clientId = ins.rows[0].id;
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[shop/checkout] client upsert failed:', e.message);
    }

    // Insert pending order row.
    const ins = await sql`
      INSERT INTO orders (
        workspace_id, client_id, customer_name, customer_email,
        items, subtotal, tax, total, status
      ) VALUES (
        ${workspaceId}, ${clientId}, ${customerName}, ${customerEmail},
        ${JSON.stringify(items)}::jsonb, ${subtotal}, ${tax}, ${total}, 'pending'
      ) RETURNING id
    `;
    const orderId = ins.rows[0].id;

    // Mint Stripe Checkout session against the connected acct.
    let creds;
    try { creds = await loadStripeCreds(workspaceId); }
    catch (e) {
      return badRequest(res, e.code === 'no_stripe_connection'
        ? "This business isn't accepting online payments yet."
        : e.message);
    }

    const base = appUrl();
    const stripeBody = {
      mode: 'payment',
      success_url: `${base}/site/${encodeURIComponent(handle)}?order=success`,
      cancel_url:  `${base}/site/${encodeURIComponent(handle)}?order=cancel`,
      customer_email: customerEmail,
      'metadata[order_id]':     orderId,
      'metadata[workspace_id]': workspaceId,
      'payment_intent_data[metadata][order_id]':     orderId,
      'payment_intent_data[metadata][workspace_id]': workspaceId,
    };
    items.forEach((it, i) => {
      stripeBody[`line_items[${i}][price_data][currency]`] = (creds.currency || 'USD').toLowerCase();
      stripeBody[`line_items[${i}][price_data][unit_amount]`] = Math.round(Number(it.rate) * 100);
      stripeBody[`line_items[${i}][price_data][product_data][name]`] = it.name;
      stripeBody[`line_items[${i}][quantity]`] = it.qty;
    });

    const headers = {
      Authorization: `Bearer ${creds.secretKey}`,
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    };
    if (creds.stripeAccount) headers['Stripe-Account'] = creds.stripeAccount;
    const payload = new URLSearchParams(stripeBody).toString();
    const resp = await fetchTimeout('https://api.stripe.com/v1/checkout/sessions',
      { method: 'POST', headers, body: payload }, 8000);
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      // eslint-disable-next-line no-console
      console.error('[shop/checkout] stripe error:', json?.error?.message || resp.status);
      return badRequest(res, json?.error?.message || `Checkout failed (${resp.status})`);
    }

    await sql`UPDATE orders SET stripe_session_id = ${json.id} WHERE id = ${orderId}`;
    return ok(res, { url: json.url });
  } catch (err) {
    return serverError(res, err);
  }
}
