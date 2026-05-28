// Orders pipeline test: public site checkout creates pending order +
// minted Stripe Checkout session (stubbed), webhook flips status to
// paid and decrements stock. Mock Stripe via globalThis.fetch.
//
// Run with: node --import ./tests/bootstrap.mjs ./tests/orders.test.mjs

import crypto from 'node:crypto';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';

const WEBHOOK_SECRET = 'whsec_test_orders';
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_fake';

const { default: checkoutHandler } = await import('../api/site/[handle]/checkout.js');
const { default: webhookHandler }  = await import('../api/webhooks/stripe-platform.js');

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

function mkRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(o) { this.body = o; return this; },
    end(s)  { this.body = s; return this; },
  };
}
function signedWebhook(event) {
  const payload = JSON.stringify(event);
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${ts}.${payload}`).digest('hex');
  return {
    method: 'POST', body: payload,
    headers: { 'stripe-signature': `t=${ts},v1=${sig}`, 'content-type': 'application/json' },
  };
}

async function run() {
  try {
    await ensureSchemaApplied();
    const tag = `ord-${Date.now()}`;
    const handle = `shop-${tag}`;
    const acctId = `acct_${tag}`;

    // Workspace + website + products + Stripe creds.
    const uid = (await sql`INSERT INTO users (email, password_hash, terms_version, terms_accepted_at)
      VALUES (${`${tag}@example.com`}, 'x', '2026-05-05', NOW()) RETURNING id`).rows[0].id;
    const wid = (await sql`INSERT INTO workspaces (owner_id, subscription_status, business_type)
      VALUES (${uid}, 'active', 'product') RETURNING id`).rows[0].id;
    await sql`INSERT INTO finance_settings (workspace_id, stripe_connect_user_id, stripe_onboarding_status, currency)
      VALUES (${wid}, ${acctId}, 'complete', 'USD')`;
    await sql`INSERT INTO websites (workspace_id, handle, published_at)
      VALUES (${wid}, ${handle}, NOW())`;
    const p1 = (await sql`INSERT INTO products (workspace_id, name, price, track_stock, stock_qty, active)
      VALUES (${wid}, 'Vanilla Candle', 24.00, TRUE, 10, TRUE) RETURNING id`).rows[0].id;

    // ── 1. Checkout endpoint ──────────────────────────────────────
    console.log('\n[1] checkout creates pending order + Stripe session');
    // Stub globalThis.fetch for the Stripe Checkout Session call.
    const realFetch = globalThis.fetch;
    let stripeCalledWith = null;
    globalThis.fetch = async (url, opts) => {
      if (String(url).includes('/checkout/sessions')) {
        stripeCalledWith = { url: String(url), body: opts.body };
        return {
          ok: true,
          json: async () => ({ id: `cs_${tag}`, url: `https://stripe.test/pay/${tag}` }),
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    try {
      const r = mkRes();
      await checkoutHandler({
        method: 'POST',
        url: `/api/site/${handle}/checkout`,
        query: { handle },
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.1' },
        body: {
          items: [{ productId: p1, qty: 2 }],
          customer: { name: 'Alice Buyer', email: `${tag}-alice@example.com` },
        },
      }, r);
      assert(r.statusCode === 200, `checkout → 200 (got ${r.statusCode}, body=${JSON.stringify(r.body)})`);
      assert(typeof r.body?.url === 'string' && r.body.url.includes('stripe.test'),
        'response URL points at stripe');
      const pending = await sql`SELECT id, status, total, stripe_session_id, customer_email FROM orders WHERE workspace_id = ${wid}`;
      assert(pending.rows.length === 1 && pending.rows[0].status === 'pending',
        'pending order row written');
      assert(Number(pending.rows[0].total) === 48,
        `total = price * qty (got ${pending.rows[0].total})`);
      assert(pending.rows[0].stripe_session_id === `cs_${tag}`,
        'stripe_session_id stored');
      // Stripe call carried metadata.order_id + workspace_id.
      assert(stripeCalledWith?.body?.includes('metadata%5Border_id%5D'),
        'stripe call carried metadata[order_id]');

      // ── 2. Cross-tenant product rejected ──────────────────────
      console.log('\n[2] cross-tenant productId is rejected');
      const otherWid = (await sql`INSERT INTO workspaces (owner_id) VALUES (${uid}) RETURNING id`).rows[0].id;
      const otherP = (await sql`INSERT INTO products (workspace_id, name, price, active)
        VALUES (${otherWid}, 'Other', 10, TRUE) RETURNING id`).rows[0].id;
      const r2 = mkRes();
      await checkoutHandler({
        method: 'POST', url: `/api/site/${handle}/checkout`,
        query: { handle },
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.2' },
        body: {
          items: [{ productId: otherP, qty: 1 }],
          customer: { name: 'Eve', email: `${tag}-eve@example.com` },
        },
      }, r2);
      assert(r2.statusCode === 400, `cross-tenant product → 400 (got ${r2.statusCode})`);

      // ── 3. Webhook flips to paid + decrements stock ──────────
      console.log('\n[3] payment_intent.succeeded marks order paid + decrements stock');
      const orderId = pending.rows[0].id;
      const piEvent = {
        id: `evt_${tag}_pi`,
        type: 'payment_intent.succeeded',
        account: acctId,
        data: {
          object: {
            id: `pi_${tag}`,
            amount_received: 4800,
            metadata: { order_id: orderId, workspace_id: wid },
          },
        },
      };
      const wr = mkRes();
      await webhookHandler(signedWebhook(piEvent), wr);
      assert(wr.statusCode === 200, `webhook → 200 (got ${wr.statusCode}, body=${JSON.stringify(wr.body)})`);
      assert(wr.body?.applied === 'order-paid', `body.applied=order-paid (got ${JSON.stringify(wr.body)})`);
      const final = await sql`SELECT status, paid_at, stripe_payment_intent FROM orders WHERE id = ${orderId}`;
      assert(final.rows[0].status === 'paid', 'order flipped to paid');
      assert(!!final.rows[0].paid_at, 'paid_at stamped');
      const stock = await sql`SELECT stock_qty FROM products WHERE id = ${p1}`;
      assert(Number(stock.rows[0].stock_qty) === 8, `stock decremented 10 → 8 (got ${stock.rows[0].stock_qty})`);

      // ── 4. Redelivery is a no-op ────────────────────────────
      console.log('\n[4] redelivered event is idempotent');
      const wr2 = mkRes();
      await webhookHandler(signedWebhook(piEvent), wr2);
      assert(wr2.statusCode === 200 && wr2.body?.deduped === true,
        'redelivered event is deduped at the webhook layer');
      const stock2 = await sql`SELECT stock_qty FROM products WHERE id = ${p1}`;
      assert(Number(stock2.rows[0].stock_qty) === 8, 'stock unchanged on replay');
    } finally {
      globalThis.fetch = realFetch;
    }

    // Cleanup
    await sql`DELETE FROM webhook_event_dedup WHERE provider = 'stripe-platform' AND event_id LIKE ${`evt_${tag}%`}`.catch(() => {});
    await sql`DELETE FROM orders WHERE workspace_id IN (SELECT id FROM workspaces WHERE owner_id = ${uid})`;
    await sql`DELETE FROM products WHERE workspace_id IN (SELECT id FROM workspaces WHERE owner_id = ${uid})`;
    await sql`DELETE FROM finance_settings WHERE workspace_id IN (SELECT id FROM workspaces WHERE owner_id = ${uid})`;
    await sql`DELETE FROM websites WHERE workspace_id IN (SELECT id FROM workspaces WHERE owner_id = ${uid})`;
    await sql`DELETE FROM clients WHERE workspace_id IN (SELECT id FROM workspaces WHERE owner_id = ${uid})`;
    await sql`DELETE FROM workspaces WHERE owner_id = ${uid}`;
    await sql`DELETE FROM users WHERE id = ${uid}`;
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run();
