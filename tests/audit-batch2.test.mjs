// Tests for Batch-2 audit fixes (get-paid completeness).
//   #3 public invoice Pay button readiness is provider-aware (not
//      Stripe-only) — Square/PayPal workspaces can now collect.
//   #2 PayPal orders are CAPTURED on return (money actually moves), and
//      capture is idempotent for an already-captured order.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/audit-batch2.test.mjs

import { sql } from '../api/_lib/db.js';
import { isPaymentReady } from '../api/invoice-view/[token].js';
import { captureOrder } from '../api/_lib/payments/paypal.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

const createdUsers = [];
async function mkWorkspace(fsCols = {}) {
  const u = await sql`
    INSERT INTO users (email, password_hash, terms_version, terms_accepted_at)
    VALUES (${`b2-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`}, 'x', '2026-05-05', NOW())
    RETURNING id`;
  createdUsers.push(u.rows[0].id);
  const w = await sql`INSERT INTO workspaces (owner_id) VALUES (${u.rows[0].id}) RETURNING id`;
  const id = w.rows[0].id;
  await sql`INSERT INTO finance_settings (workspace_id) VALUES (${id}) ON CONFLICT (workspace_id) DO NOTHING`;
  if (Object.keys(fsCols).length) {
    // Apply provider columns one by one (keeps the dynamic SQL trivial).
    if (fsCols.payment_provider) await sql`UPDATE finance_settings SET payment_provider = ${fsCols.payment_provider} WHERE workspace_id = ${id}`;
    if (fsCols.stripe_connect_user_id) await sql`UPDATE finance_settings SET stripe_connect_user_id = ${fsCols.stripe_connect_user_id} WHERE workspace_id = ${id}`;
    if (fsCols.square_merchant_id) await sql`UPDATE finance_settings SET square_merchant_id = ${fsCols.square_merchant_id}, square_credentials_encrypted = ${fsCols.square_credentials_encrypted || 'enc'} WHERE workspace_id = ${id}`;
    if (fsCols.paypal_merchant_id) await sql`UPDATE finance_settings SET paypal_merchant_id = ${fsCols.paypal_merchant_id} WHERE workspace_id = ${id}`;
  }
  return id;
}

async function run() {
  try {
    console.log('\n[#3] isPaymentReady is provider-aware');
    const stripeWs = await mkWorkspace({ payment_provider: 'stripe', stripe_connect_user_id: 'acct_1' });
    assert((await isPaymentReady(stripeWs)) === true, 'stripe + connect acct → ready');

    const squareWs = await mkWorkspace({ payment_provider: 'square', square_merchant_id: 'M1', square_credentials_encrypted: 'enc' });
    assert((await isPaymentReady(squareWs)) === true, 'square + merchant + creds → ready (was hidden before)');

    const paypalWs = await mkWorkspace({ payment_provider: 'paypal', paypal_merchant_id: 'PM1' });
    assert((await isPaymentReady(paypalWs)) === true, 'paypal + merchant → ready (was hidden before)');

    const squareNoCreds = await mkWorkspace({ payment_provider: 'square' });
    assert((await isPaymentReady(squareNoCreds)) === false, 'square active but not connected → not ready');

    const stripeDefaultUnconnected = await mkWorkspace({});
    assert((await isPaymentReady(stripeDefaultUnconnected)) === false, 'default stripe, unconnected → not ready');

    console.log('\n[#2] PayPal captureOrder');
    process.env.PAYPAL_CLIENT_ID ||= 'cid';
    process.env.PAYPAL_CLIENT_SECRET ||= 'csec';
    process.env.PAYPAL_PARTNER_ID ||= 'pid';
    const settings = { paypalMerchantId: 'MERCHANT', paypalEnvironment: 'sandbox' };

    const realFetch = globalThis.fetch;
    let captureHit = null;
    globalThis.fetch = async (url, opts = {}) => {
      const u = String(url);
      if (u.includes('/v1/oauth2/token')) {
        return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3000 }) };
      }
      if (u.includes('/v2/checkout/orders/') && u.endsWith('/capture')) {
        captureHit = { url: u, headers: opts.headers || {} };
        return { ok: true, status: 201, json: async () => ({ status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: 'CAP1' }] } }] }) };
      }
      throw new Error('unexpected fetch ' + u);
    };
    try {
      const r = await captureOrder({ orderId: 'ORD123', settings });
      assert(r.status === 'COMPLETED' && r.captureId === 'CAP1', 'capture POSTs and returns COMPLETED + captureId');
      assert(captureHit?.url.includes('/v2/checkout/orders/ORD123/capture'), 'hits the order capture endpoint');
      assert(!!captureHit?.headers['PayPal-Auth-Assertion'], 'sends merchant auth assertion');

      // Already-captured → treated as success (idempotent return-URL refresh).
      globalThis.fetch = async (url) => {
        const u = String(url);
        if (u.includes('/v1/oauth2/token')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3000 }) };
        return { ok: false, status: 422, json: async () => ({ details: [{ issue: 'ORDER_ALREADY_CAPTURED' }] }) };
      };
      const r2 = await captureOrder({ orderId: 'ORD123', settings });
      assert(r2.alreadyCaptured === true && r2.status === 'COMPLETED', 'ORDER_ALREADY_CAPTURED treated as success');
    } finally {
      globalThis.fetch = realFetch;
    }
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  } finally {
    for (const id of createdUsers) {
      await sql`DELETE FROM workspaces WHERE owner_id = ${id}`.catch(() => {});
      await sql`DELETE FROM users WHERE id = ${id}`.catch(() => {});
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run();
