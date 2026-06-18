// Tests the VERIFIABLE core of PayPal membership subscriptions:
//   • parseWebhookEvent normalizes BILLING.SUBSCRIPTION.* + PAYMENT.SALE.COMPLETED
//   • applyPaypalSubscriptionEvent creates/updates/cancels client_memberships
// The live PayPal-API calls (createBillingPlan / createSubscription) are NOT
// covered here - they need a PayPal sandbox to validate (deferred by design).
//
// Run with:
//   node --import ./tests/bootstrap.mjs ./tests/paypal-subscriptions.test.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { parseWebhookEvent } from '../api/_lib/payments/paypal.js';
import { applyPaypalSubscriptionEvent } from '../api/_lib/paypalApply.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

async function run() {
  await ensureSchemaApplied();

  console.log('\n[1] parseWebhookEvent normalizes subscription events');
  const md = { workspace_id: 'W', membership_id: 'M', client_id: 'C' };
  const act = parseWebhookEvent({
    event_type: 'BILLING.SUBSCRIPTION.ACTIVATED',
    resource: { id: 'SUB1', custom_id: JSON.stringify(md), billing_info: { next_billing_time: '2026-07-01T00:00:00Z' }, plan_id: 'PLAN1' },
  });
  assert(act?.type === 'subscription.updated' && act.subStatus === 'active', 'ACTIVATED → subscription.updated/active');
  assert(act.subscriptionId === 'SUB1' && act.metadata?.membership_id === 'M', 'subscriptionId + custom_id metadata parsed');
  assert(act.nextBillingTime === '2026-07-01T00:00:00Z', 'next_billing_time carried through');
  assert(parseWebhookEvent({ event_type: 'BILLING.SUBSCRIPTION.CANCELLED', resource: { id: 'SUB1' } })?.subStatus === 'cancelled', 'CANCELLED → cancelled');
  assert(parseWebhookEvent({ event_type: 'BILLING.SUBSCRIPTION.SUSPENDED', resource: { id: 'SUB1' } })?.subStatus === 'past_due', 'SUSPENDED → past_due');
  const sale = parseWebhookEvent({ event_type: 'PAYMENT.SALE.COMPLETED', resource: { id: 'SALE1', billing_agreement_id: 'SUB1', amount: { total: '20.00', currency: 'USD' } } });
  assert(sale?.type === 'subscription.renewed' && sale.subscriptionId === 'SUB1', 'recurring SALE → subscription.renewed for the agreement');
  assert(parseWebhookEvent({ event_type: 'PAYMENT.SALE.COMPLETED', resource: { id: 'SALE2' } }) === null, 'one-off SALE (no agreement) is not a subscription event');

  console.log('\n[2] applyPaypalSubscriptionEvent drives client_memberships');
  const tag = `pps-${Date.now()}`;
  const uid = (await sql`INSERT INTO users (email, password_hash, terms_version, terms_accepted_at)
    VALUES (${`${tag}@example.com`}, 'x', '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  const wid = (await sql`INSERT INTO workspaces (owner_id) VALUES (${uid}) RETURNING id`).rows[0].id;
  const cid = (await sql`INSERT INTO clients (workspace_id, name, email, stage) VALUES (${wid}, 'Mem Ber', ${`${tag}-c@example.com`}, 'active') RETURNING id`).rows[0].id;
  const mid = (await sql`INSERT INTO memberships (workspace_id, name, price_cents, interval, active) VALUES (${wid}, 'Gold', 2000, 'month', TRUE) RETURNING id`).rows[0].id;

  const meta = { workspace_id: wid, membership_id: mid, client_id: cid };
  const activated = { type: 'subscription.updated', subscriptionId: 'SUBX', subStatus: 'active', nextBillingTime: '2026-07-01T00:00:00Z', metadata: meta };

  assert((await applyPaypalSubscriptionEvent({ parsed: activated })) === 'created', 'first ACTIVATED creates the client membership');
  let cm = (await sql`SELECT * FROM client_memberships WHERE paypal_subscription_id = 'SUBX'`).rows;
  assert(cm.length === 1 && cm[0].provider === 'paypal' && cm[0].status === 'active', 'one row, provider paypal, active');
  assert(cm[0].membership_name === 'Gold' && Number(cm[0].price_cents) === 2000 && cm[0].interval === 'month', 'tier snapshot copied');

  // Idempotent: a duplicate ACTIVATED must not create a second row.
  await applyPaypalSubscriptionEvent({ parsed: activated });
  cm = (await sql`SELECT * FROM client_memberships WHERE paypal_subscription_id = 'SUBX'`).rows;
  assert(cm.length === 1, 'duplicate ACTIVATED does not create a second row');

  // Renewal extends the period.
  const renewed = { type: 'subscription.renewed', subscriptionId: 'SUBX', subStatus: 'active', nextBillingTime: '2026-08-01T00:00:00Z' };
  assert((await applyPaypalSubscriptionEvent({ parsed: renewed })) === 'renewed', 'renewal applies');
  cm = (await sql`SELECT current_period_end FROM client_memberships WHERE paypal_subscription_id = 'SUBX'`).rows[0];
  assert(new Date(cm.current_period_end).toISOString().startsWith('2026-08-01'), 'current_period_end advanced to the new billing date');

  // Cancellation.
  assert((await applyPaypalSubscriptionEvent({ parsed: { type: 'subscription.updated', subscriptionId: 'SUBX', subStatus: 'cancelled' } })) === 'cancelled', 'cancellation applies');
  cm = (await sql`SELECT status, cancelled_at FROM client_memberships WHERE paypal_subscription_id = 'SUBX'`).rows[0];
  assert(cm.status === 'cancelled' && cm.cancelled_at, 'status cancelled + cancelled_at stamped');

  console.log('\n[3] guards');
  assert((await applyPaypalSubscriptionEvent({ parsed: { type: 'subscription.updated', subscriptionId: 'GHOST', subStatus: 'cancelled' } })) === 'unknown-subscription', 'cancel for an unknown subscription is a no-op');
  assert((await applyPaypalSubscriptionEvent({ parsed: { type: 'subscription.updated', subscriptionId: 'NOMETA', subStatus: 'active', metadata: {} } })) === 'missing-metadata', 'active without metadata cannot create a row');

  // Cleanup.
  await sql`DELETE FROM client_memberships WHERE workspace_id = ${wid}`;
  await sql`DELETE FROM memberships WHERE workspace_id = ${wid}`;
  await sql`DELETE FROM clients WHERE workspace_id = ${wid}`;
  await sql`DELETE FROM workspaces WHERE id = ${wid}`;
  await sql`DELETE FROM users WHERE id = ${uid}`;

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
