// Memberships (recurring subscriptions), end to end, through the real
// handlers against local Postgres. Stripe is mocked by replacing
// globalThis.fetch (every call is recorded); webhooks arrive as real signed
// payloads at the platform webhook.
//
//   [1] owner: create tiers (Stripe product + price), list, edit, archive,
//       validation, workspace isolation
//   [2] public checkout: subscription-mode session on the connected account
//   [3] lifecycle: subscription.created (race) → active → owner member list →
//       renewal → change-plan with proration → retier via webhook → client
//       cancels at period end → payment failure tells both sides → deleted
//       revokes → Dashboard-created sub with no metadata
//   [4] client portal isolation + archived business
//   [5] user-facing copy
//
// Run with: node --import ./tests/bootstrap.mjs ./tests/memberships-e2e.test.mjs
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.STRIPE_SECRET_KEY = 'sk_test_memberships';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_memberships';
process.env.APP_URL ||= 'https://www.joinivy.ai';

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import platformWebhook from '../api/webhooks/stripe-platform.js';
import membershipsIndex from '../api/memberships/index.js';
import membershipById from '../api/memberships/[id].js';
import membershipCheckout from '../api/memberships/checkout.js';
import changePlan from '../api/memberships/change-plan.js';
import membersList from '../api/memberships/members.js';
import meMemberships from '../api/me/memberships/index.js';
import meMembership from '../api/me/memberships/[id].js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

// ── Stripe + Resend mock ─────────────────────────────────────────────
const calls = [];
const emails = [];
let subItems = [{ id: 'si_1', price: { id: 'price_current' } }];
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
let seq = 0;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url); const method = (init.method || 'GET').toUpperCase();
  if (/api\.resend\.com/.test(u)) {
    try { emails.push(JSON.parse(String(init.body))); } catch { emails.push({}); }
    return json({ id: `em_${emails.length}` });
  }
  const body = init.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : {};
  const headers = init.headers || {};
  calls.push({ url: u, method, body, headers });
  if (/\/v1\/products$/.test(u) && method === 'POST') return json({ id: `prod_${++seq}` });
  if (/\/v1\/prices$/.test(u) && method === 'POST') return json({ id: `price_${++seq}`, unit_amount: Number(body.unit_amount) });
  if (/\/v1\/customers\?/.test(u) && method === 'GET') return json({ data: [] });
  if (/\/v1\/customers$/.test(u) && method === 'POST') return json({ id: `cus_${++seq}`, email: body.email });
  if (/\/v1\/customers\/[^/?]+$/.test(u) && method === 'GET') return json({ id: u.split('/').pop(), email: `dash-${u.split('/').pop()}@example.com`, name: 'Dash Dana' });
  if (/\/v1\/checkout\/sessions$/.test(u) && method === 'POST') return json({ id: `cs_${++seq}`, url: `https://checkout.stripe.com/c/${seq}`, customer: body.customer });
  if (/\/v1\/subscriptions\/[^/?]+$/.test(u) && method === 'GET') return json({ id: u.split('/').pop(), items: { data: subItems }, metadata: {} });
  if (/\/v1\/subscriptions\/[^/?]+$/.test(u) && method === 'POST') return json({ id: u.split('/').pop(), status: 'active', ...body });
  if (/\/v1\/subscriptions\/[^/?]+$/.test(u) && method === 'DELETE') return json({ id: u.split('/').pop(), status: 'canceled' });
  return json({});
};
const stripeCalls = (re) => calls.filter((c) => re.test(`${c.method} ${c.url}`));
const lastStripe = (re) => stripeCalls(re).at(-1);

// ── request helpers ──────────────────────────────────────────────────
function mkRes() {
  return {
    statusCode: 200, headers: {}, body: undefined, req: null,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(o) { this.body = o; return this; },
    end(s) { this.body = s ?? this.body; return this; },
    writeHead(c) { this.statusCode = c; return this; },
  };
}
const HOST = 'www.joinivy.ai';
// Public checkouts are rate limited per IP per hour; a fresh base per run
// keeps repeated local runs from tripping it.
const IPB = `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
function req({ method = 'GET', cookie, query = {}, body, origin = `https://${HOST}`, ip = `${IPB}.5` } = {}) {
  return {
    method, url: '/t', query, body,
    headers: { 'content-type': 'application/json', host: HOST, origin, 'x-forwarded-for': ip, 'user-agent': 'test', ...(cookie ? { cookie } : {}) },
  };
}
async function call(handler, r) { const res = mkRes(); res.req = r; await handler(r, res); return res; }
const cookieFor = (uid) => `ivy_session=${signSession(uid)}`;
let evtN = 0;
async function fire(type, object, acct) {
  const payload = JSON.stringify({ id: `evt_mem_${Date.now()}_${++evtN}`, type, account: acct, data: { object } });
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET).update(`${ts}.${payload}`).digest('hex');
  const res = mkRes();
  await platformWebhook({ method: 'POST', url: '/api/webhooks/stripe-platform', body: payload, headers: { 'stripe-signature': `t=${ts},v1=${sig}`, 'content-type': 'application/json' } }, res);
  return res;
}
const subObj = (id, priceId, over = {}) => ({
  id, object: 'subscription', status: 'active', cancel_at_period_end: false,
  current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400, customer: 'cus_member', items: { data: [{ id: 'si_1', price: { id: priceId } }] },
  ...over,
});
const cmRow = (subId) => sql`SELECT * FROM client_memberships WHERE stripe_subscription_id = ${subId}`.then((r) => r.rows[0]);

// ── fixtures ─────────────────────────────────────────────────────────
const STAMP = Date.now();
async function mkOwner(label) {
  const u = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, terms_version, terms_accepted_at)
    VALUES (${`me-${label}-${STAMP}@example.com`}, 'x', ${`${label} Owner`}, NOW(), '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  const wid = (await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, onboarded_at)
    VALUES (${u}, ${`${label} Studio`}, 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`).rows[0].id;
  const slug = `me-${label}-${STAMP}`;
  await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug) VALUES (${wid}, ${`${label} Studio`}, ${slug})
    ON CONFLICT (workspace_id) DO UPDATE SET biz_name = ${`${label} Studio`}, slug = ${slug}`;
  const acct = `acct_me_${label}_${STAMP}`;
  await sql`INSERT INTO finance_settings (workspace_id, stripe_connect_user_id, stripe_onboarding_status, currency)
    VALUES (${wid}, ${acct}, 'complete', 'USD')`;
  return { uid: u, wid, acct, slug, cookie: cookieFor(u), name: `${label} Studio` };
}
async function mkClientUser(label, wid, email) {
  const u = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, terms_version, terms_accepted_at)
    VALUES (${email}, 'x', ${label}, NOW(), '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  const cid = (await sql`INSERT INTO clients (workspace_id, user_id, name, email, stage) VALUES (${wid}, ${u}, ${label}, ${email}, 'active') RETURNING id`).rows[0].id;
  return { uid: u, cid, email, cookie: cookieFor(u) };
}

async function run() {
  await ensureSchemaApplied();
  const A = await mkOwner('alpha');
  const B = await mkOwner('beta');
  const cleanupUsers = [A.uid, B.uid];

  // ════════════════════════════════════════════════════════════════════
  console.log('\n[1] owner: tiers');
  let r = await call(membershipsIndex, req({ method: 'POST', cookie: A.cookie, body: { priceCents: 4900 } }));
  assert(r.statusCode === 400 && /name/i.test(r.body.error), 'missing name → 400');
  r = await call(membershipsIndex, req({ method: 'POST', cookie: A.cookie, body: { name: 'X', priceCents: -100 } }));
  assert(r.statusCode === 400 && /price/i.test(r.body.error), 'negative price → 400');
  r = await call(membershipsIndex, req({ method: 'POST', cookie: A.cookie, body: { name: 'X', priceCents: 12.5 } }));
  assert(r.statusCode === 201 && r.body.membership.priceCents === 13, 'fractional cents are rounded, not rejected');
  const stray = r.body.membership;
  r = await call(membershipsIndex, req({ method: 'POST', cookie: A.cookie, body: { name: 'X', priceCents: 100, interval: 'daily' } }));
  assert(r.statusCode === 400 && /interval/i.test(r.body.error), 'unknown interval → 400');
  r = await call(membershipsIndex, req({ method: 'POST', body: { name: 'X', priceCents: 100 } }));
  assert(r.statusCode === 401, 'unauthenticated → 401');

  calls.length = 0;
  r = await call(membershipsIndex, req({ method: 'POST', cookie: A.cookie, body: { name: 'Monthly', description: 'Come often.', priceCents: 4900, interval: 'month', perks: ['Unlimited bookings', '', '10% off products'] } }));
  assert(r.statusCode === 201 && r.body.membership.stripeReady === true && !r.body.stripeError, `monthly tier created with a Stripe price (got ${JSON.stringify(r.body).slice(0, 160)})`);
  const monthly = r.body.membership;
  assert(monthly.perks.length === 2 && monthly.perks[0] === 'Unlimited bookings', 'blank perks dropped');
  let prod = lastStripe(/POST .*\/v1\/products$/); let price = lastStripe(/POST .*\/v1\/prices$/);
  assert(prod?.body.name === 'Monthly' && prod.headers['Stripe-Account'] === A.acct && price?.headers['Stripe-Account'] === A.acct, 'Stripe product + price created on the connected account');
  assert(price.body.unit_amount === '4900' && price.body.currency === 'usd' && price.body['recurring[interval]'] === 'month' && price.body['recurring[interval_count]'] === '1', 'monthly recurring price 4900 usd');
  calls.length = 0;
  r = await call(membershipsIndex, req({ method: 'POST', cookie: A.cookie, body: { name: 'Annual', priceCents: 49900, interval: 'year' } }));
  const annual = r.body.membership;
  price = lastStripe(/POST .*\/v1\/prices$/);
  assert(r.statusCode === 201 && price.body['recurring[interval]'] === 'year' && price.body.unit_amount === '49900', 'annual recurring price');
  calls.length = 0;
  r = await call(membershipsIndex, req({ method: 'POST', cookie: A.cookie, body: { name: 'Quarterly', priceCents: 12900, interval: 'quarter' } }));
  price = lastStripe(/POST .*\/v1\/prices$/);
  assert(r.statusCode === 201 && price.body['recurring[interval]'] === 'month' && price.body['recurring[interval_count]'] === '3', 'quarterly = every 3 months on Stripe');
  const quarterly = r.body.membership;

  r = await call(membershipsIndex, req({ cookie: A.cookie }));
  assert(r.statusCode === 200 && r.body.memberships.length === 4 && r.body.memberships.every((m) => m.stripeReady), 'owner list shows every tier');
  r = await call(membershipById, req({ method: 'PATCH', cookie: A.cookie, query: { id: monthly.id }, body: { name: 'Monthly Member', perks: ['Unlimited bookings'], description: 'Updated' } }));
  assert(r.statusCode === 200 && r.body.membership.name === 'Monthly Member' && r.body.membership.perks.length === 1 && r.body.membership.priceCents === 4900, 'PATCH name/perks/description');
  r = await call(membershipById, req({ method: 'PATCH', cookie: A.cookie, query: { id: monthly.id }, body: { priceCents: 5900 } }));
  assert(r.statusCode === 400 && /Price and interval/.test(r.body.error), 'price change refused (Stripe prices are immutable)');
  r = await call(membershipById, req({ method: 'PATCH', cookie: A.cookie, query: { id: monthly.id }, body: { name: '' } }));
  assert(r.statusCode === 400, 'blank name refused');
  r = await call(membershipById, req({ method: 'DELETE', cookie: A.cookie, query: { id: stray.id } }));
  assert(r.statusCode === 204 && (await sql`SELECT active FROM memberships WHERE id = ${stray.id}`).rows[0].active === false, 'DELETE archives (row kept, active=false)');

  r = await call(membershipById, req({ cookie: B.cookie, query: { id: monthly.id } }));
  assert(r.statusCode === 404, 'other owner GET → 404');
  r = await call(membershipById, req({ method: 'PATCH', cookie: B.cookie, query: { id: monthly.id }, body: { name: 'Hijacked' } }));
  assert(r.statusCode === 404, 'other owner PATCH → 404');
  r = await call(membershipById, req({ method: 'DELETE', cookie: B.cookie, query: { id: monthly.id } }));
  assert(r.statusCode === 404 && (await sql`SELECT active, name FROM memberships WHERE id = ${monthly.id}`).rows[0].active === true, 'other owner DELETE → 404, tier untouched');
  r = await call(membershipsIndex, req({ cookie: B.cookie }));
  assert(r.body.memberships.length === 0, "B's list is empty");

  // ════════════════════════════════════════════════════════════════════
  console.log('\n[2] public checkout');
  const buyer = { name: 'Casey Client', email: `me-casey-${STAMP}@example.com` };
  r = await call(membershipCheckout, req({ method: 'POST', body: { membershipId: monthly.id, ...buyer } }));
  assert(r.statusCode === 400 && /slug/.test(r.body.error), 'missing slug → 400');
  r = await call(membershipCheckout, req({ method: 'POST', body: { slug: 'nobody-here', membershipId: monthly.id, ...buyer } }));
  assert(r.statusCode === 404, 'unknown handle → 404');
  r = await call(membershipCheckout, req({ method: 'POST', body: { slug: A.slug, membershipId: monthly.id, email: buyer.email } }));
  assert(r.statusCode === 400 && /name/i.test(r.body.error), 'missing name → 400');
  r = await call(membershipCheckout, req({ method: 'POST', body: { slug: A.slug, membershipId: stray.id, ...buyer } }));
  assert(r.statusCode === 400 && /no longer/.test(r.body.error), 'archived tier → 400');
  r = await call(membershipCheckout, req({ method: 'POST', body: { slug: B.slug, membershipId: monthly.id, ...buyer } }));
  assert(r.statusCode === 404, "A's tier through B's handle → 404");
  // A client the owner typed in with mixed case already exists.
  const existing = (await sql`INSERT INTO clients (workspace_id, name, email, stage) VALUES (${A.wid}, 'Casey', ${`ME-Casey-${STAMP}@Example.com`}, 'active') RETURNING id`).rows[0].id;
  calls.length = 0;
  r = await call(membershipCheckout, req({ method: 'POST', body: { slug: A.slug, membershipId: monthly.id, ...buyer } }));
  assert(r.statusCode === 200 && /checkout\.stripe\.com/.test(r.body.url), `checkout → Stripe URL (got ${r.statusCode} ${JSON.stringify(r.body)})`);
  assert((await sql`SELECT COUNT(*)::int n FROM clients WHERE workspace_id = ${A.wid} AND LOWER(email) = ${buyer.email}`).rows[0].n === 1, 'existing client matched case-insensitively (no duplicate)');
  const cs = lastStripe(/POST .*\/v1\/checkout\/sessions$/);
  const client = (await sql`SELECT * FROM clients WHERE id = ${existing}`).rows[0];
  assert(cs.body.mode === 'subscription' && cs.body['line_items[0][price]'] && cs.body.customer === client.stripe_customer_id && cs.headers['Stripe-Account'] === A.acct, 'subscription-mode session for the tier price on the connected account');
  assert(cs.body['metadata[purpose]'] === 'membership' && cs.body['metadata[membership_id]'] === monthly.id && cs.body['metadata[client_id]'] === existing && cs.body['metadata[workspace_id]'] === A.wid, 'session metadata');
  assert(cs.body['subscription_data[metadata][purpose]'] === 'membership' && cs.body['subscription_data[metadata][client_id]'] === existing && cs.body['subscription_data[metadata][workspace_id]'] === A.wid, 'subscription metadata for the webhook');
  assert(cs.body.success_url.includes(`/book/${A.slug}?membership=joined`), 'returns to the booking page');
  const priceId = cs.body['line_items[0][price]'];

  // ════════════════════════════════════════════════════════════════════
  console.log('\n[3] lifecycle');
  const subId = `sub_me_${STAMP}`;
  const md = { workspace_id: A.wid, membership_id: monthly.id, client_id: existing, purpose: 'membership' };
  const cpe1 = Math.floor(Date.now() / 1000) + 30 * 86400;
  r = await fire('customer.subscription.created', subObj(subId, priceId, { metadata: md, current_period_end: cpe1, customer: client.stripe_customer_id }), A.acct);
  assert(r.statusCode === 200 && r.body.result === 'created', `subscription.created (before anything else) materialises the membership (got ${JSON.stringify(r.body)})`);
  let cm = await cmRow(subId);
  assert(cm && cm.status === 'active' && cm.client_id === existing && cm.membership_id === monthly.id && cm.membership_name === 'Monthly Member' && Number(cm.price_cents) === 4900, 'active row with the tier snapshot');
  r = await fire('customer.subscription.created', subObj(subId, priceId, { metadata: md, current_period_end: cpe1 }), A.acct);
  assert((await sql`SELECT COUNT(*)::int n FROM client_memberships WHERE stripe_subscription_id = ${subId}`).rows[0].n === 1, 'duplicate created event keeps one row');
  r = await fire('checkout.session.completed', { id: 'cs_sub', mode: 'subscription', payment_status: 'paid', subscription: subId, metadata: md }, A.acct);
  assert(r.statusCode === 200 && (await sql`SELECT COUNT(*)::int n FROM client_memberships WHERE client_id = ${existing}`).rows[0].n === 1, 'late checkout.session.completed does not duplicate');

  r = await call(membersList, req({ cookie: A.cookie }));
  let mem = r.body.members.find((m) => m.clientId === existing);
  assert(r.statusCode === 200 && mem && mem.status === 'active' && mem.membershipName === 'Monthly Member' && mem.hasStripe && !mem.cancelAtPeriodEnd && !!mem.currentPeriodEnd, 'owner member list: active, tier, renewal date');
  r = await call(membersList, req({ cookie: B.cookie }));
  assert(r.body.members.length === 0, "owner B's member list is empty");

  // Renewal.
  const cpe2 = cpe1 + 30 * 86400;
  r = await fire('customer.subscription.updated', subObj(subId, priceId, { metadata: md, current_period_end: cpe2 }), A.acct);
  cm = await cmRow(subId);
  assert(r.body.result === 'ok' && cm.status === 'active' && Math.abs(new Date(cm.current_period_end).getTime() / 1000 - cpe2) < 2, 'renewal advances the period end');

  // Change plan (owner) with proration, then the webhook retiers.
  const annualPrice = (await sql`SELECT stripe_price_id FROM memberships WHERE id = ${annual.id}`).rows[0].stripe_price_id;
  subItems = [{ id: 'si_live', price: { id: priceId } }];
  r = await call(changePlan, req({ method: 'POST', cookie: B.cookie, body: { clientMembershipId: cm.id, newMembershipId: annual.id } }));
  assert(r.statusCode === 404, "other owner cannot change A's member's plan");
  r = await call(changePlan, req({ method: 'POST', cookie: A.cookie, body: { clientMembershipId: cm.id, newMembershipId: monthly.id } }));
  assert(r.statusCode === 400 && /already/.test(r.body.error), 'same tier → 400');
  r = await call(changePlan, req({ method: 'POST', cookie: A.cookie, body: { clientMembershipId: cm.id, newMembershipId: stray.id } }));
  assert(r.statusCode === 400, 'archived target tier → 400');
  calls.length = 0;
  r = await call(changePlan, req({ method: 'POST', cookie: A.cookie, body: { clientMembershipId: cm.id, newMembershipId: annual.id } }));
  assert(r.statusCode === 200 && r.body.changed && r.body.targetTier.id === annual.id, `change plan → ok (got ${JSON.stringify(r.body)})`);
  const upd = lastStripe(new RegExp(`POST .*/v1/subscriptions/${subId}$`));
  assert(upd && upd.body['items[0][id]'] === 'si_live' && upd.body['items[0][price]'] === annualPrice && upd.body.proration_behavior === 'create_prorations' && upd.headers['Stripe-Account'] === A.acct, 'Stripe: swap the item price with proration');
  assert((await cmRow(subId)).membership_id === monthly.id, 'local row waits for the webhook');
  r = await fire('customer.subscription.updated', subObj(subId, annualPrice, { metadata: md, current_period_end: cpe2 }), A.acct);
  cm = await cmRow(subId);
  assert(r.body.result === 'retiered' && cm.membership_id === annual.id && cm.membership_name === 'Annual' && Number(cm.price_cents) === 49900 && cm.interval === 'year', 'webhook resyncs the tier snapshot');
  r = await call(membersList, req({ cookie: A.cookie }));
  assert(r.body.members.find((m) => m.clientId === existing)?.membershipName === 'Annual', 'owner member list shows the new tier');

  // Client portal + cancel at period end.
  const casey = await mkClientUser('Casey Client', A.wid, buyer.email);
  await sql`UPDATE clients SET user_id = ${casey.uid} WHERE id = ${existing}`;
  await sql`DELETE FROM clients WHERE id = ${casey.cid}`;
  cleanupUsers.push(casey.uid);
  r = await call(meMemberships, req({ cookie: casey.cookie }));
  let mine = r.body.memberships?.[0];
  assert(r.statusCode === 200 && r.body.memberships.length === 1 && mine.membershipName === 'Annual' && mine.businessName === A.name && mine.status === 'active' && !mine.cancelAtPeriodEnd && !!mine.currentPeriodEnd, 'portal: active membership with business, tier and renewal date');
  const dana = await mkClientUser('Dana Other', B.wid, `me-dana-${STAMP}@example.com`);
  cleanupUsers.push(dana.uid);
  r = await call(meMemberships, req({ cookie: dana.cookie }));
  assert(r.body.memberships.length === 0, "a client of B sees none of A's memberships");
  r = await call(meMembership, req({ method: 'DELETE', cookie: dana.cookie, query: { id: cm.id } }));
  assert(r.statusCode === 404 && (await cmRow(subId)).cancel_at_period_end === false, "a client of B cannot cancel A's member");
  r = await call(meMembership, req({ method: 'DELETE', cookie: casey.cookie, query: { id: cm.id }, origin: 'https://evil.example.com' }));
  assert(r.statusCode === 403, 'cancel from a foreign origin is refused (CSRF)');
  calls.length = 0;
  r = await call(meMembership, req({ method: 'DELETE', cookie: casey.cookie, query: { id: cm.id } }));
  assert(r.statusCode === 200 && r.body.cancelled && r.body.atPeriodEnd, 'client cancels at period end');
  const cancelCall = lastStripe(new RegExp(`POST .*/v1/subscriptions/${subId}$`));
  assert(cancelCall && cancelCall.body.cancel_at_period_end === 'true' && cancelCall.headers['Stripe-Account'] === A.acct, 'Stripe: cancel_at_period_end on the connected account');
  cm = await cmRow(subId);
  assert(cm.status === 'active' && cm.cancel_at_period_end === true, 'locally: active, auto-renew off');
  r = await call(meMemberships, req({ cookie: casey.cookie }));
  mine = r.body.memberships[0];
  assert(mine.cancelAtPeriodEnd === true && mine.status === 'active' && Math.abs(new Date(mine.currentPeriodEnd).getTime() / 1000 - cpe2) < 2, 'portal: Access until <period end>');
  r = await fire('customer.subscription.updated', subObj(subId, annualPrice, { metadata: md, current_period_end: cpe2, cancel_at_period_end: true }), A.acct);
  assert((await cmRow(subId)).status === 'active', 'webhook echo keeps access until the period end');
  r = await call(membersList, req({ cookie: A.cookie }));
  assert(r.body.members.find((m) => m.clientId === existing)?.cancelAtPeriodEnd === true, 'owner sees "cancels <date>"');

  // Payment failure: past_due, both sides told once.
  emails.length = 0;
  r = await fire('customer.subscription.updated', subObj(subId, annualPrice, { metadata: md, current_period_end: cpe2, status: 'past_due' }), A.acct);
  assert((await cmRow(subId)).status === 'past_due', 'failed renewal → past_due');
  await settle();
  const failMail = emails.find((m) => /Payment failed/.test(m.subject || ''));
  const failTo = [].concat(failMail?.to || []).map((t) => String(t).toLowerCase());
  assert(!!failMail && failTo.includes(buyer.email) && /Annual/.test(failMail.subject), `client emailed about the failed payment (got ${emails.map((m) => m.subject).join(' | ')} → ${failTo.join(',')})`);
  r = await call(meMemberships, req({ cookie: casey.cookie }));
  assert(r.body.memberships[0]?.status === 'past_due', 'portal flags past due, still listed');
  emails.length = 0;
  r = await fire('customer.subscription.updated', subObj(subId, annualPrice, { metadata: md, current_period_end: cpe2, status: 'unpaid' }), A.acct);
  await settle();
  assert((await cmRow(subId)).status === 'past_due' && emails.length === 0, 'a second failure event does not email again');
  r = await fire('customer.subscription.updated', subObj(subId, annualPrice, { metadata: md, current_period_end: cpe2, status: 'active' }), A.acct);
  assert((await cmRow(subId)).status === 'active', 'recovered → active');

  // Deleted: access ends.
  r = await fire('customer.subscription.deleted', subObj(subId, annualPrice, { metadata: md, current_period_end: cpe2, status: 'canceled' }), A.acct);
  cm = await cmRow(subId);
  assert(cm.status === 'cancelled' && !!cm.cancelled_at, 'subscription.deleted → cancelled');
  r = await call(meMemberships, req({ cookie: casey.cookie }));
  assert(r.body.memberships.length === 0, 'portal hides the cancelled membership');
  r = await call(meMembership, req({ method: 'DELETE', cookie: casey.cookie, query: { id: cm.id } }));
  assert(r.statusCode === 400 && /Already cancelled/.test(r.body.error), 'cancelling again → 400');
  r = await call(membersList, req({ cookie: A.cookie }));
  mem = r.body.members.find((m) => m.clientId === existing);
  assert(mem?.status === 'cancelled' && !!mem.cancelledAt, 'owner member list keeps the history as cancelled');
  r = await call(changePlan, req({ method: 'POST', cookie: A.cookie, body: { clientMembershipId: cm.id, newMembershipId: quarterly.id } }));
  assert(r.statusCode === 400 && /cancelled/.test(r.body.error), 'cannot change the plan of a cancelled membership');

  // Dashboard-created subscription: no Ivy metadata, matched by customer + price.
  r = await fire('customer.subscription.created', subObj(`sub_dash_${STAMP}`, annualPrice, { customer: client.stripe_customer_id }), A.acct);
  const dash = await cmRow(`sub_dash_${STAMP}`);
  assert(r.body.result === 'created' && dash?.client_id === existing && dash.membership_id === annual.id, 'Dashboard sub (no metadata) resolved via customer + price');
  // ... and for a customer Ivy has never seen, the client is provisioned from Stripe.
  r = await fire('customer.subscription.created', subObj(`sub_dash2_${STAMP}`, annualPrice, { customer: `cus_new_${STAMP}` }), A.acct);
  const dash2 = await cmRow(`sub_dash2_${STAMP}`);
  const newClient = dash2 ? (await sql`SELECT * FROM clients WHERE id = ${dash2.client_id}`).rows[0] : null;
  assert(r.body.result === 'created' && newClient?.workspace_id === A.wid && newClient.email === `dash-cus_new_${STAMP}@example.com` && newClient.stripe_customer_id === `cus_new_${STAMP}`, 'unknown customer is fetched from Stripe and a client row is created in this workspace');
  // Cross-workspace metadata is refused.
  r = await fire('customer.subscription.created', subObj('sub_cross', priceId, { metadata: { ...md, workspace_id: B.wid } }), A.acct);
  assert(r.statusCode === 400, 'subscription naming another workspace → 400');
  // Unknown price + unknown customer: nothing is written.
  r = await fire('customer.subscription.created', subObj('sub_unknown', 'price_nobody', { customer: 'cus_nobody' }), A.acct);
  assert(r.body.result === 'race' && !(await cmRow('sub_unknown')), 'unmatched subscription writes nothing');

  // ════════════════════════════════════════════════════════════════════
  console.log('\n[4] archived business');
  await sql`UPDATE workspaces SET subscription_status = 'cancelled', subscription_period_end = NOW() - INTERVAL '1 day' WHERE id = ${A.wid}`;
  r = await call(membershipCheckout, req({ method: 'POST', body: { slug: A.slug, membershipId: monthly.id, ...buyer }, ip: `${IPB}.6` }));
  assert(r.statusCode === 403 && r.body.code === 'business_archived', 'lapsed business: membership checkout → 403');
  await sql`UPDATE workspaces SET subscription_status = 'active', subscription_period_end = NOW() + INTERVAL '30 days' WHERE id = ${A.wid}`;
  r = await call(membershipCheckout, req({ method: 'POST', body: { slug: A.slug, membershipId: monthly.id, ...buyer }, ip: `${IPB}.7` }));
  assert(r.statusCode === 200, 'resubscribed: checkout works again');

  // ════════════════════════════════════════════════════════════════════
  console.log('\n[5] user-facing copy');
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  for (const f of ['src/features/finance/Memberships.jsx', 'src/features/client/ClientBilling.jsx', 'api/_lib/memberships.js', 'api/memberships/index.js', 'api/memberships/[id].js', 'api/memberships/change-plan.js', 'api/me/memberships/index.js']) {
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    assert(!text.includes('—') && !/business os/i.test(text) && !/\b(Claude|Anthropic)\b/.test(text), `${f}: no em dashes, no "business OS", no vendor names`);
  }

  await sql.query('DELETE FROM workspaces WHERE id = ANY($1)', [[A.wid, B.wid]]);
  await sql.query('DELETE FROM users WHERE id = ANY($1)', [cleanupUsers]);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
