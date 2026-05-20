// Regression test for the platform billing webhook idempotency fix.
//
// Stripe redelivers events on any non-2xx / timeout. Before the fix the
// billing webhook (unlike every other provider webhook) had no event-id
// dedup, so a redelivered invoice.payment_succeeded re-sent owner emails
// and re-ran referral/affiliate side effects. This test proves the same
// event id is processed once and short-circuited on redelivery.
//
// Run with:
//   node --import ./tests/bootstrap.mjs ./tests/billing-webhook-dedup.test.mjs

import crypto from 'node:crypto';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';

const WEBHOOK_SECRET = 'whsec_test_dedup';
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_fake';
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;

const { default: billingHandler } = await import('../api/webhooks/billing.js');

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { pass++; console.log('  ✓', label); }
  else      { fail++; console.log('  ✗', label); }
}

function signedReq(event) {
  const payload = JSON.stringify(event);
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${ts}.${payload}`).digest('hex');
  return {
    method: 'POST',
    url: '/api/webhooks/billing',
    body: payload, // readRawBody returns req.body when it's a string
    headers: {
      'stripe-signature': `t=${ts},v1=${sig}`,
      'content-type': 'application/json',
    },
  };
}

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

async function run() {
  try {
    await ensureSchemaApplied();

    // Use an event TYPE the handler doesn't act on (default → "ignored"),
    // so we isolate the dedup gate (which runs BEFORE the switch, and is
    // type-agnostic) without dragging in Stripe API calls. A unique id
    // per run keeps the test independent of prior runs.
    const eventId = `evt_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const event = { id: eventId, type: 'customer.updated', data: { object: { id: 'cus_x' } } };

    console.log('\n[1] bad signature is rejected');
    const badRes = mkRes();
    await billingHandler({
      method: 'POST', url: '/x', body: JSON.stringify(event),
      headers: { 'stripe-signature': 't=1,v1=deadbeef' },
    }, badRes);
    assert(badRes.statusCode === 400, 'tampered/old signature → 400');

    console.log('\n[2] first delivery is processed');
    const res1 = mkRes();
    await billingHandler(signedReq(event), res1);
    assert(res1.statusCode === 200, 'first delivery → 200');
    assert(res1.body?.deduped !== true, 'first delivery is NOT marked deduped');

    const afterFirst = await sql`
      SELECT COUNT(*)::int AS n FROM webhook_event_dedup
      WHERE provider = 'billing' AND event_id = ${eventId}
    `;
    assert(afterFirst.rows[0].n === 1, 'dedup row recorded for (billing, eventId)');

    console.log('\n[3] redelivery of the same event id is short-circuited');
    const res2 = mkRes();
    await billingHandler(signedReq(event), res2);
    assert(res2.statusCode === 200, 'redelivery → 200 (so Stripe stops retrying)');
    assert(res2.body?.deduped === true, 'redelivery is marked deduped');

    const afterSecond = await sql`
      SELECT COUNT(*)::int AS n FROM webhook_event_dedup
      WHERE provider = 'billing' AND event_id = ${eventId}
    `;
    assert(afterSecond.rows[0].n === 1, 'still exactly one dedup row (no duplicate)');

    // Cleanup.
    await sql`DELETE FROM webhook_event_dedup WHERE provider = 'billing' AND event_id = ${eventId}`.catch(() => {});
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run();
