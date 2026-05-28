// End-to-end test of the Stripe platform webhook handler:
//   /api/webhooks/stripe-platform (default export)
//
// Fires real signed payloads at the handler (Stripe-Signature verifies)
// and asserts the database state after. Covers three reliability paths
// added on top of the original checkout.session.completed flow:
//
//   [1] payment_intent.succeeded marks an invoice paid as a safety net
//       when checkout.session.completed never lands.
//   [2] customer.subscription.created arriving FIRST (race) — handler
//       materializes client_memberships from sub.metadata.
//   [3] customer.subscription.created with NO THRYVE metadata at all
//       (a sub created in the Stripe Dashboard) — matched by
//       sub.customer ↔ clients.stripe_customer_id and
//       sub.items[0].price.id ↔ memberships.stripe_price_id.
//
// Run with:
//   node --import ./tests/bootstrap.mjs ./tests/stripe-platform-webhook.test.mjs

import crypto from 'node:crypto';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';

const WEBHOOK_SECRET = 'whsec_test_platform';
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_fake';

const { default: handler } = await import('../api/webhooks/stripe-platform.js');

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

function signedReq(event) {
  const payload = JSON.stringify(event);
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${ts}.${payload}`).digest('hex');
  return {
    method: 'POST',
    url: '/api/webhooks/stripe-platform',
    body: payload,
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
async function callHandler(event) {
  const res = mkRes();
  await handler(signedReq(event), res);
  return res;
}

async function run() {
  try {
    await ensureSchemaApplied();

    // Provision a workspace whose finance_settings.stripe_connect_user_id
    // matches the event.account on every signed event below.
    const tag = `spw-${Date.now()}`;
    const acctId = `acct_${tag}`;
    const uid = (await sql`INSERT INTO users (email, password_hash, terms_version, terms_accepted_at)
      VALUES (${`${tag}@example.com`}, 'x', '2026-05-05', NOW()) RETURNING id`).rows[0].id;
    const wid = (await sql`INSERT INTO workspaces (owner_id) VALUES (${uid}) RETURNING id`).rows[0].id;
    await sql`INSERT INTO finance_settings (workspace_id, stripe_connect_user_id, stripe_onboarding_status)
      VALUES (${wid}, ${acctId}, 'complete')`;

    console.log('\n[1] payment_intent.succeeded marks the invoice paid');
    const cid = (await sql`INSERT INTO clients (workspace_id, name, email, stage)
      VALUES (${wid}, 'Pay Test', ${`${tag}-pay@example.com`}, 'active') RETURNING id`).rows[0].id;
    const inv = (await sql`INSERT INTO invoices (workspace_id, client_id, number, status, items, tax_rate, discount)
      VALUES (${wid}, ${cid}, 'INV-PI-001', 'sent', ${JSON.stringify([{ description: 'Service', qty: 1, price: 100 }])}::jsonb, 0, 0)
      RETURNING id`).rows[0].id;

    const piEvent = {
      id: `evt_pi_${tag}_1`,
      type: 'payment_intent.succeeded',
      account: acctId,
      data: {
        object: {
          id: `pi_${tag}_A`,
          amount_received: 10000,
          metadata: { invoice_id: inv, workspace_id: wid },
        },
      },
    };
    const r1 = await callHandler(piEvent);
    assert(r1.statusCode === 200, `PI succeeded webhook → 200 (got ${r1.statusCode})`);
    assert(r1.body?.applied === 'invoice-paid', `body.applied=invoice-paid (got ${JSON.stringify(r1.body)})`);
    const invRow = (await sql`SELECT status, paid_at, stripe_payment_intent FROM invoices WHERE id = ${inv}`).rows[0];
    assert(invRow.status === 'paid', 'invoice flipped to paid');
    assert(!!invRow.paid_at, 'paid_at stamped');
    assert(invRow.stripe_payment_intent === `pi_${tag}_A`, 'stripe_payment_intent recorded');

    // Redelivery of the same event id must dedup.
    const r1b = await callHandler(piEvent);
    assert(r1b.statusCode === 200 && r1b.body?.deduped === true, 'redelivered PI event is deduped');

    console.log('\n[2] customer.subscription.created (race) materializes from metadata');
    const cidM = (await sql`INSERT INTO clients (workspace_id, name, email, stage)
      VALUES (${wid}, 'Member', ${`${tag}-mem@example.com`}, 'lead') RETURNING id`).rows[0].id;
    const midM = (await sql`INSERT INTO memberships (workspace_id, name, price_cents, interval, active)
      VALUES (${wid}, 'Plat', 2500, 'month', TRUE) RETURNING id`).rows[0].id;
    const subEvent = {
      id: `evt_sub_${tag}_1`,
      type: 'customer.subscription.created',
      account: acctId,
      data: {
        object: {
          id: `sub_${tag}_M`,
          status: 'active',
          cancel_at_period_end: false,
          current_period_end: 1893456000,
          customer: `cus_${tag}_M`,
          items: { data: [{ price: { id: 'price_meta_first' } }] },
          metadata: {
            workspace_id: wid, membership_id: midM, client_id: cidM, purpose: 'membership',
          },
        },
      },
    };
    const r2 = await callHandler(subEvent);
    assert(r2.statusCode === 200, 'subscription.created webhook → 200');
    assert(r2.body?.result === 'created', `body.result=created (got ${JSON.stringify(r2.body)})`);
    const mem = (await sql`SELECT * FROM client_memberships WHERE stripe_subscription_id = ${`sub_${tag}_M`}`).rows[0];
    assert(mem && mem.client_id === cidM && mem.membership_id === midM, 'membership row inserted, linked correctly');
    assert(mem.status === 'active', 'status active');

    console.log('\n[3] Stripe-Dashboard-originated sub (no metadata) is matched + inserted');
    const cidD = (await sql`INSERT INTO clients (workspace_id, name, email, stage, stripe_customer_id)
      VALUES (${wid}, 'Dash Client', ${`${tag}-dash@example.com`}, 'active', 'cus_dash_e2e') RETURNING id`).rows[0].id;
    const midD = (await sql`INSERT INTO memberships (workspace_id, name, price_cents, interval, active, stripe_price_id)
      VALUES (${wid}, 'Dash Tier', 3000, 'month', TRUE, 'price_dash_e2e') RETURNING id`).rows[0].id;
    const dashEvent = {
      id: `evt_sub_${tag}_2`,
      type: 'customer.subscription.created',
      account: acctId,
      data: {
        object: {
          id: `sub_${tag}_D`,
          status: 'active',
          customer: 'cus_dash_e2e',
          items: { data: [{ price: { id: 'price_dash_e2e' } }] },
          current_period_end: 1893456000,
          // No metadata at all.
        },
      },
    };
    const r3 = await callHandler(dashEvent);
    assert(r3.statusCode === 200, 'dashboard sub webhook → 200');
    assert(r3.body?.result === 'created', `body.result=created (got ${JSON.stringify(r3.body)})`);
    const dashRow = (await sql`SELECT * FROM client_memberships WHERE stripe_subscription_id = ${`sub_${tag}_D`}`).rows[0];
    assert(dashRow && dashRow.client_id === cidD && dashRow.membership_id === midD, 'dashboard sub resolved via customer+price');

    console.log('\n[4] tampered signature is rejected (defense in depth)');
    const tampered = {
      method: 'POST',
      headers: { 'stripe-signature': 't=1,v1=deadbeef', 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'evt_x', type: 'payment_intent.succeeded' }),
    };
    const resBad = mkRes();
    await handler(tampered, resBad);
    assert(resBad.statusCode === 400, 'tampered signature → 400');

    // Cleanup
    await sql`DELETE FROM webhook_event_dedup WHERE provider = 'stripe-platform' AND event_id IN (
      ${piEvent.id}, ${subEvent.id}, ${dashEvent.id}
    )`.catch(() => {});
    await sql`DELETE FROM client_memberships WHERE workspace_id = ${wid}`;
    await sql`DELETE FROM memberships WHERE workspace_id = ${wid}`;
    await sql`DELETE FROM invoices WHERE workspace_id = ${wid}`;
    await sql`DELETE FROM clients WHERE workspace_id = ${wid}`;
    await sql`DELETE FROM finance_settings WHERE workspace_id = ${wid}`;
    await sql`DELETE FROM workspaces WHERE id = ${wid}`;
    await sql`DELETE FROM users WHERE id = ${uid}`;
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run();
