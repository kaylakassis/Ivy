// Tests applySubscriptionState() handles the customer.subscription.created
// arriving BEFORE checkout.session.completed (Stripe doesn't guarantee
// event ordering). Previously the handler returned 'race' and skipped,
// leaving a live Stripe subscription with no Ivy OS client_memberships
// row. Now it upserts from sub.metadata (workspace_id/membership_id/
// client_id/purpose stamped by createMembershipCheckoutSession).
//
// Run with:
//   node --import ./tests/bootstrap.mjs ./tests/stripe-membership-race.test.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { applySubscriptionState } from '../api/_lib/memberships.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

async function run() {
  await ensureSchemaApplied();

  const tag = `smr-${Date.now()}`;
  const uid = (await sql`INSERT INTO users (email, password_hash, terms_version, terms_accepted_at)
    VALUES (${`${tag}@example.com`}, 'x', '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  const wid = (await sql`INSERT INTO workspaces (owner_id) VALUES (${uid}) RETURNING id`).rows[0].id;
  const cid = (await sql`INSERT INTO clients (workspace_id, name, email, stage)
    VALUES (${wid}, 'Race Buyer', ${`${tag}-c@example.com`}, 'lead') RETURNING id`).rows[0].id;
  const mid = (await sql`INSERT INTO memberships (workspace_id, name, price_cents, interval, active)
    VALUES (${wid}, 'Silver', 1500, 'month', TRUE) RETURNING id`).rows[0].id;

  console.log('\n[1] customer.subscription.created arrives BEFORE session.completed');
  const sub = {
    id: `sub_${tag}_A`,
    status: 'active',
    cancel_at_period_end: false,
    current_period_end: 1893456000, // 2030-01-01
    metadata: { workspace_id: wid, membership_id: mid, client_id: cid, purpose: 'membership' },
  };
  const r1 = await applySubscriptionState({ workspaceId: wid, sub });
  assert(r1 === 'created', `first call materializes the row (got '${r1}')`);
  const row1 = (await sql`SELECT * FROM client_memberships WHERE stripe_subscription_id = ${sub.id}`).rows[0];
  assert(row1 && row1.client_id === cid, 'row exists, linked to correct client');
  assert(row1.membership_name === 'Silver' && Number(row1.price_cents) === 1500, 'tier snapshot copied from membership template');
  assert(row1.status === 'active', 'status mapped from Stripe (active)');
  assert(!!row1.current_period_end, 'current_period_end populated');

  console.log('\n[2] late session.completed INSERT loses the race safely (handled at webhook layer)');
  // The webhook's INSERT is wrapped in an existence check. Confirm a
  // second applySubscriptionState() with an updated state still works
  // through the regular UPDATE path now that the row exists.
  const r2 = await applySubscriptionState({
    workspaceId: wid,
    sub: { ...sub, status: 'past_due' },
  });
  assert(r2 === 'ok', `second call uses UPDATE path (got '${r2}')`);
  const row2 = (await sql`SELECT status FROM client_memberships WHERE stripe_subscription_id = ${sub.id}`).rows[0];
  assert(row2.status === 'past_due', 'status updated to past_due');

  console.log('\n[3] race remains when metadata insufficient');
  const r3 = await applySubscriptionState({
    workspaceId: wid,
    sub: { id: `sub_${tag}_B`, status: 'active', metadata: { purpose: 'membership' } },
  });
  assert(r3 === 'race', `missing client_id/membership_id → race (got '${r3}')`);

  const r4 = await applySubscriptionState({
    workspaceId: wid,
    sub: { id: `sub_${tag}_C`, status: 'active', metadata: { workspace_id: wid, membership_id: mid, client_id: cid } },
  });
  assert(r4 === 'race', `missing purpose=membership → race (got '${r4}')`);

  console.log('\n[4] cross-tenant metadata is rejected, not silently inserted');
  const r5 = await applySubscriptionState({
    workspaceId: wid,
    sub: {
      id: `sub_${tag}_D`, status: 'active',
      metadata: { workspace_id: 'a0000000-0000-0000-0000-000000000000', membership_id: mid, client_id: cid, purpose: 'membership' },
    },
  });
  assert(r5 === 'mismatch', `metadata.workspace_id mismatch rejected (got '${r5}')`);

  console.log('\n[5] tier/client not in this workspace → race (no insert)');
  const r6 = await applySubscriptionState({
    workspaceId: wid,
    sub: {
      id: `sub_${tag}_E`, status: 'active',
      metadata: { workspace_id: wid, membership_id: 'a0000000-0000-0000-0000-000000000000', client_id: cid, purpose: 'membership' },
    },
  });
  assert(r6 === 'race', `unknown membership id → race (got '${r6}')`);

  console.log('\n[6] Stripe-Dashboard-originated sub (no Ivy OS metadata) matches via customer + price');
  // Stamp the client with a stripe_customer_id + provision a Stripe
  // price on the tier — this is the state for a workspace where the
  // owner set up recurring billing in the Stripe Dashboard, not via
  // Ivy OS's checkout flow.
  await sql`UPDATE clients SET stripe_customer_id = 'cus_dash_match' WHERE id = ${cid}`;
  await sql`UPDATE memberships SET stripe_price_id = 'price_dash_silver' WHERE id = ${mid}`;
  const dashSub = {
    id: `sub_${tag}_F`,
    status: 'active',
    customer: 'cus_dash_match',
    items: { data: [{ price: { id: 'price_dash_silver' } }] },
    current_period_end: 1893456000,
    // No metadata at all — that's the whole point.
  };
  const r7 = await applySubscriptionState({ workspaceId: wid, sub: dashSub });
  assert(r7 === 'created', `dashboard sub matched + materialized (got '${r7}')`);
  const dashRow = (await sql`SELECT * FROM client_memberships WHERE stripe_subscription_id = ${dashSub.id}`).rows[0];
  assert(dashRow && dashRow.client_id === cid && dashRow.membership_id === mid, 'dashboard sub linked to right client + tier via stripe_customer_id + stripe_price_id');

  console.log('\n[7] Plan-change resyncs tier snapshot');
  // Create a second tier on the same workspace and provision its price.
  const mid2 = (await sql`INSERT INTO memberships (workspace_id, name, price_cents, interval, active, stripe_price_id)
    VALUES (${wid}, 'Gold', 5000, 'month', TRUE, 'price_dash_gold') RETURNING id`).rows[0].id;
  // Existing sub gets switched to the Gold price (owner edited from Stripe Dashboard or via change-plan UI).
  const upgraded = {
    ...dashSub,
    status: 'active',
    items: { data: [{ price: { id: 'price_dash_gold' } }] },
  };
  const r8 = await applySubscriptionState({ workspaceId: wid, sub: upgraded });
  assert(r8 === 'retiered', `plan change returns 'retiered' (got '${r8}')`);
  const retieredRow = (await sql`SELECT * FROM client_memberships WHERE stripe_subscription_id = ${dashSub.id}`).rows[0];
  assert(retieredRow.membership_id === mid2, 'membership_id updated to new tier');
  assert(retieredRow.membership_name === 'Gold', 'membership_name resynced');
  assert(Number(retieredRow.price_cents) === 5000, 'price_cents resynced');

  console.log('\n[8] same-tier update is still ok, not retiered');
  const r9 = await applySubscriptionState({
    workspaceId: wid,
    sub: { ...upgraded, status: 'past_due' },
  });
  assert(r9 === 'ok', `same-price update returns 'ok' (got '${r9}')`);

  console.log('\n[9] Dashboard sub with unknown price → race (no insert)');
  const r10 = await applySubscriptionState({
    workspaceId: wid,
    sub: {
      id: `sub_${tag}_G`, status: 'active',
      customer: 'cus_dash_match',
      items: { data: [{ price: { id: 'price_unknown' } }] },
    },
  });
  assert(r10 === 'race', `unknown price → race (got '${r10}')`);

  console.log('\n[10] Auto-provision clients row from Stripe customer when unknown');
  // stripeContext provides credentials so applySubscriptionState can
  // fetch the unknown customer from Stripe. We stub globalThis.fetch
  // to return a synthetic customer payload instead of hitting Stripe.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/customers/cus_new_buyer')) {
      return {
        ok: true,
        json: async () => ({ id: 'cus_new_buyer', email: 'autoprov@example.com', name: 'Auto Buyer' }),
      };
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  };
  try {
    const r11 = await applySubscriptionState({
      workspaceId: wid,
      sub: {
        id: `sub_${tag}_H`, status: 'active',
        customer: 'cus_new_buyer',
        items: { data: [{ price: { id: 'price_dash_silver' } }] },
        current_period_end: 1893456000,
      },
      stripeContext: { secretKey: 'sk_test_fake', stripeAccount: 'acct_test' },
    });
    assert(r11 === 'created', `auto-provisioned client + sub (got '${r11}')`);
    const newClient = (await sql`SELECT id, email FROM clients WHERE workspace_id = ${wid} AND email = 'autoprov@example.com'`).rows[0];
    assert(!!newClient, 'clients row created from Stripe customer email');
    const newMem = (await sql`SELECT client_id FROM client_memberships WHERE stripe_subscription_id = ${`sub_${tag}_H`}`).rows[0];
    assert(newMem && newMem.client_id === newClient.id, 'membership linked to new client');
  } finally {
    globalThis.fetch = realFetch;
  }

  console.log('\n[11] Auto-provision links to EXISTING client when email matches');
  // The owner had the client in CRM already; the auto-provision path
  // should attach the stripe_customer_id, not create a duplicate.
  await sql`INSERT INTO clients (workspace_id, name, email, stage)
    VALUES (${wid}, 'Pre-existing', 'preexisting@example.com', 'active')`;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/customers/cus_link_existing')) {
      return { ok: true, json: async () => ({ id: 'cus_link_existing', email: 'preexisting@example.com', name: 'Pre-existing' }) };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  try {
    const r12 = await applySubscriptionState({
      workspaceId: wid,
      sub: {
        id: `sub_${tag}_I`, status: 'active',
        customer: 'cus_link_existing',
        items: { data: [{ price: { id: 'price_dash_silver' } }] },
      },
      stripeContext: { secretKey: 'sk_test_fake', stripeAccount: 'acct_test' },
    });
    assert(r12 === 'created', `linked to existing client (got '${r12}')`);
    const cnt = (await sql`SELECT COUNT(*)::int AS n FROM clients WHERE workspace_id = ${wid} AND email = 'preexisting@example.com'`).rows[0].n;
    assert(cnt === 1, 'no duplicate clients row created');
    const linked = (await sql`SELECT stripe_customer_id FROM clients WHERE workspace_id = ${wid} AND email = 'preexisting@example.com'`).rows[0];
    assert(linked.stripe_customer_id === 'cus_link_existing', 'existing client stamped with stripe_customer_id');
  } finally {
    globalThis.fetch = realFetch;
  }

  // Cleanup
  await sql`DELETE FROM client_memberships WHERE workspace_id = ${wid}`;
  await sql`DELETE FROM memberships WHERE workspace_id = ${wid}`;
  await sql`DELETE FROM clients WHERE workspace_id = ${wid}`;
  await sql`DELETE FROM workspaces WHERE id = ${wid}`;
  await sql`DELETE FROM users WHERE id = ${uid}`;

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
