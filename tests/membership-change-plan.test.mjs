// Tests POST /api/memberships/change-plan - owner-side endpoint that
// switches a client's recurring tier on Stripe. Validates auth gating,
// input handling, cross-tenant defense, and that the right Stripe call
// gets made (subscriptions.update with proration_behavior=
// create_prorations + the new price). The webhook layer is responsible
// for resyncing the local snapshot - covered by stripe-membership-race.
//
// globalThis.fetch is stubbed so this test doesn't hit Stripe.
//
// Run with:
//   node --import ./tests/bootstrap.mjs ./tests/membership-change-plan.test.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_fake';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_for_local_dev_only_at_least_32_chars';

const { default: handler } = await import('../api/memberships/change-plan.js');

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
function authReq(body, cookieHeader) {
  return {
    method: 'POST', url: '/api/memberships/change-plan',
    headers: {
      'content-type': 'application/json',
      origin: 'http://localhost:3000',
      host: 'localhost:3000',
      cookie: cookieHeader,
    },
    body,
  };
}

async function run() {
  try {
    await ensureSchemaApplied();

    const tag = `cp-${Date.now()}`;
    const uid = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, terms_version, terms_accepted_at)
      VALUES (${`${tag}@example.com`}, 'x', 'Owner', NOW(), '2026-05-05', NOW()) RETURNING id`).rows[0].id;
    const wid = (await sql`INSERT INTO workspaces (owner_id, subscription_status, subscription_period_end) VALUES (${uid}, 'active', NOW() + INTERVAL '30 days') RETURNING id`).rows[0].id;
    await sql`INSERT INTO finance_settings (workspace_id, stripe_connect_user_id, stripe_onboarding_status, currency)
      VALUES (${wid}, ${`acct_${tag}`}, 'complete', 'USD')`;
    const cid = (await sql`INSERT INTO clients (workspace_id, name, email, stage)
      VALUES (${wid}, 'C', ${`${tag}-c@example.com`}, 'active') RETURNING id`).rows[0].id;
    const tierA = (await sql`INSERT INTO memberships (workspace_id, name, price_cents, interval, active, stripe_price_id)
      VALUES (${wid}, 'A', 1000, 'month', TRUE, 'price_a') RETURNING id`).rows[0].id;
    const tierB = (await sql`INSERT INTO memberships (workspace_id, name, price_cents, interval, active, stripe_price_id)
      VALUES (${wid}, 'B', 2500, 'month', TRUE, 'price_b') RETURNING id`).rows[0].id;
    const cm = (await sql`INSERT INTO client_memberships (workspace_id, client_id, membership_id,
      membership_name, price_cents, interval, stripe_subscription_id, status)
      VALUES (${wid}, ${cid}, ${tierA}, 'A', 1000, 'month', ${`sub_${tag}`}, 'active') RETURNING id`).rows[0].id;
    const cookie = `ivy_session=${signSession(uid)}`;

    // Capture Stripe calls.
    const seen = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts = {}) => {
      seen.push({ url: String(url), method: opts.method || 'GET', body: opts.body || '' });
      // GET subscription → return one with items.data[0].id set
      if (String(url).endsWith(`/subscriptions/sub_${tag}`) && (!opts.method || opts.method === 'GET')) {
        return { ok: true, json: async () => ({
          id: `sub_${tag}`, status: 'active',
          metadata: { workspace_id: wid },
          items: { data: [{ id: 'si_existing', price: { id: 'price_a' } }] },
        }) };
      }
      // POST subscription → swap price
      if (String(url).endsWith(`/subscriptions/sub_${tag}`) && opts.method === 'POST') {
        return { ok: true, json: async () => ({ id: `sub_${tag}` }) };
      }
      throw new Error(`unexpected fetch: ${opts.method || 'GET'} ${url}`);
    };

    try {
      console.log('\n[1] auth + validation');
      const r0 = mkRes(); await handler(authReq({}, cookie), r0);
      assert(r0.statusCode === 400 && /clientMembershipId/i.test(r0.body?.error || ''), 'missing clientMembershipId → 400');

      const r1 = mkRes(); await handler(authReq({ clientMembershipId: cm }, cookie), r1);
      assert(r1.statusCode === 400 && /newMembershipId/i.test(r1.body?.error || ''), 'missing newMembershipId → 400');

      console.log('\n[2] same-tier rejected');
      const r2 = mkRes(); await handler(authReq({ clientMembershipId: cm, newMembershipId: tierA }, cookie), r2);
      assert(r2.statusCode === 400 && /already on that tier/i.test(r2.body?.error || ''), 'switching to same tier → 400');

      console.log('\n[3] cross-tenant - different workspace cm id is 404, not switched');
      const otherU = (await sql`INSERT INTO users (email, password_hash, terms_version, terms_accepted_at)
        VALUES (${`${tag}-other@example.com`}, 'x', '2026-05-05', NOW()) RETURNING id`).rows[0].id;
      const otherW = (await sql`INSERT INTO workspaces (owner_id) VALUES (${otherU}) RETURNING id`).rows[0].id;
      const otherC = (await sql`INSERT INTO clients (workspace_id, name, email, stage) VALUES (${otherW}, 'X', ${`${tag}-x@example.com`}, 'active') RETURNING id`).rows[0].id;
      const otherT = (await sql`INSERT INTO memberships (workspace_id, name, price_cents, interval, active, stripe_price_id)
        VALUES (${otherW}, 'Z', 100, 'month', TRUE, 'price_z') RETURNING id`).rows[0].id;
      const otherCM = (await sql`INSERT INTO client_memberships (workspace_id, client_id, membership_id, membership_name, price_cents, interval, stripe_subscription_id, status)
        VALUES (${otherW}, ${otherC}, ${otherT}, 'Z', 100, 'month', 'sub_other', 'active') RETURNING id`).rows[0].id;
      const r3 = mkRes(); await handler(authReq({ clientMembershipId: otherCM, newMembershipId: tierB }, cookie), r3);
      assert(r3.statusCode === 404, `another workspace's cm id → 404 (got ${r3.statusCode})`);

      console.log('\n[4] happy path - Stripe gets called with the right body');
      seen.length = 0;
      const r4 = mkRes(); await handler(authReq({ clientMembershipId: cm, newMembershipId: tierB }, cookie), r4);
      assert(r4.statusCode === 200, `change-plan → 200 (got ${r4.statusCode}, body=${JSON.stringify(r4.body)})`);
      assert(r4.body?.changed === true, 'response body.changed=true');
      assert(r4.body?.targetTier?.id === tierB, 'response carries new tier id');

      const sawFetchSub = seen.some((c) => c.method === 'GET' && c.url.endsWith(`/subscriptions/sub_${tag}`));
      assert(sawFetchSub, 'fetched the existing subscription to get item id');
      const updateCall = seen.find((c) => c.method === 'POST' && c.url.endsWith(`/subscriptions/sub_${tag}`));
      assert(!!updateCall, 'POSTed an update to the subscription');
      const params = new URLSearchParams(updateCall?.body || '');
      assert(params.get('items[0][id]') === 'si_existing', 'items[0][id] passed through');
      assert(params.get('items[0][price]') === 'price_b', 'items[0][price] = new tier price');
      assert(params.get('proration_behavior') === 'create_prorations', 'proration_behavior = create_prorations');

      console.log('\n[5] new tier without Stripe price is rejected');
      const tierC = (await sql`INSERT INTO memberships (workspace_id, name, price_cents, interval, active)
        VALUES (${wid}, 'C', 3000, 'month', TRUE) RETURNING id`).rows[0].id;
      const r5 = mkRes(); await handler(authReq({ clientMembershipId: cm, newMembershipId: tierC }, cookie), r5);
      assert(r5.statusCode === 400 && /Stripe price/i.test(r5.body?.error || ''), 'tier without stripe_price_id → 400');

      // Cleanup
      await sql`DELETE FROM client_memberships WHERE workspace_id IN (${wid}, ${otherW})`;
      await sql`DELETE FROM memberships WHERE workspace_id IN (${wid}, ${otherW})`;
      await sql`DELETE FROM clients WHERE workspace_id IN (${wid}, ${otherW})`;
      await sql`DELETE FROM finance_settings WHERE workspace_id = ${wid}`;
      await sql`DELETE FROM workspaces WHERE id IN (${wid}, ${otherW})`;
      await sql`DELETE FROM users WHERE id IN (${uid}, ${otherU})`;
    } finally {
      globalThis.fetch = realFetch;
    }
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run();
