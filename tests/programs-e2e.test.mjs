// Programs, end to end, through the real handlers against local Postgres.
// Stripe is mocked by replacing globalThis.fetch (every call is recorded so
// the test can assert what would have been sent); webhooks arrive as real
// signed payloads.
//
//   [1] owner: create / edit / publish / archive, validation, workspace isolation
//   [2] one-time purchase: public page → checkout → paid webhook → access →
//       duplicate webhook no-op → unpaid session grants nothing → portal →
//       access window expires via the cron → re-purchase → Dashboard refund
//   [3] subscription program: checkout → subscription.created (also before
//       anything else landed) → renewal → client cancels at period end →
//       payment failure tells both sides → deleted revokes → owner revoke
//       cancels the Stripe subscription → legacy per-workspace webhook
//   [4] archived business refuses new purchases
//   [5] user-facing copy
//
// Run with: node --import ./tests/bootstrap.mjs ./tests/programs-e2e.test.mjs
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.STRIPE_SECRET_KEY = 'sk_test_programs';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_programs';
process.env.SECRETS_KEY = process.env.SECRETS_KEY || 'a'.repeat(64);
process.env.CRON_SECRET = process.env.CRON_SECRET || 'cron_programs_secret';
process.env.APP_URL ||= 'https://www.joinivy.ai';

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import { encrypt } from '../api/_lib/secrets.js';
import platformWebhook from '../api/webhooks/stripe-platform.js';
import legacyWebhook from '../api/webhooks/stripe/[workspaceId].js';
import programsIndex from '../api/programs/index.js';
import programById from '../api/programs/[id].js';
import programItems from '../api/programs/[id]/items.js';
import programMembers from '../api/programs/[id]/members.js';
import programPublic from '../api/programs/public/[id].js';
import programCheckout from '../api/programs/checkout.js';
import mePrograms from '../api/me/programs/index.js';
import meProgram from '../api/me/programs/[id].js';
import meProgramSub from '../api/me/programs/[id]/subscription.js';
import programAccessCron from '../api/cron/program-access.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

// ── Stripe + Resend mock ─────────────────────────────────────────────
const calls = [];
const emails = [];
let stripeFail = null; // { pattern, status, message } to make one route fail
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
  if (stripeFail && stripeFail.pattern.test(`${method} ${u}`)) {
    return json({ error: { message: stripeFail.message || 'boom' } }, stripeFail.status || 500);
  }
  if (/\/v1\/customers\?/.test(u) && method === 'GET') return json({ data: [] });
  if (/\/v1\/customers$/.test(u) && method === 'POST') return json({ id: `cus_${++seq}`, email: body.email });
  if (/\/v1\/checkout\/sessions$/.test(u) && method === 'POST') return json({ id: `cs_${++seq}`, url: `https://checkout.stripe.com/c/${seq}`, customer: body.customer });
  if (/\/v1\/subscriptions\/[^/?]+$/.test(u) && method === 'GET') return json({ id: u.split('/').pop(), items: { data: [{ id: 'si_1', price: { id: 'price_x' } }] }, metadata: {} });
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
function sign(payload, secret) {
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', secret).update(`${ts}.${payload}`).digest('hex');
  return `t=${ts},v1=${sig}`;
}
async function fire(type, object, acct) {
  const payload = JSON.stringify({ id: `evt_prog_${Date.now()}_${++evtN}`, type, account: acct, data: { object } });
  const res = mkRes();
  await platformWebhook({ method: 'POST', url: '/api/webhooks/stripe-platform', body: payload, headers: { 'stripe-signature': sign(payload, process.env.STRIPE_WEBHOOK_SECRET), 'content-type': 'application/json' } }, res);
  return res;
}
async function fireLegacy(type, object, workspaceId, secret) {
  const payload = JSON.stringify({ id: `evt_legacy_${Date.now()}_${++evtN}`, type, data: { object } });
  const res = mkRes();
  await legacyWebhook({ method: 'POST', url: `/api/webhooks/stripe/${workspaceId}`, query: { workspaceId }, body: payload, headers: { 'stripe-signature': sign(payload, secret), 'content-type': 'application/json' } }, res);
  return res;
}
const subObj = (id, over = {}) => ({
  id, object: 'subscription', status: 'active', cancel_at_period_end: false,
  current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400, customer: 'cus_sub', items: { data: [{ id: 'si_1', price: { id: 'price_inline' } }] },
  ...over,
});
const enrollment = (programId, clientId) => sql`SELECT * FROM program_enrollments WHERE program_id = ${programId} AND client_id = ${clientId} ORDER BY granted_at DESC LIMIT 1`.then((r) => r.rows[0]);

// ── fixtures ─────────────────────────────────────────────────────────
const STAMP = Date.now();
async function mkOwner(label, { legacy = false } = {}) {
  const u = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, terms_version, terms_accepted_at)
    VALUES (${`pe-${label}-${STAMP}@example.com`}, 'x', ${`${label} Owner`}, NOW(), '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  const wid = (await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, onboarded_at)
    VALUES (${u}, ${`${label} Studio`}, 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`).rows[0].id;
  await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug) VALUES (${wid}, ${`${label} Studio`}, ${`pe-${label}-${STAMP}`})
    ON CONFLICT (workspace_id) DO UPDATE SET biz_name = ${`${label} Studio`}, slug = ${`pe-${label}-${STAMP}`}`;
  const acct = `acct_pe_${label}_${STAMP}`;
  const whSecret = `whsec_legacy_${label}`;
  if (legacy) {
    await sql`INSERT INTO finance_settings (workspace_id, stripe_secret_encrypted, stripe_webhook_secret_encrypted, currency)
      VALUES (${wid}, ${encrypt('sk_live_legacy_owner_key')}, ${encrypt(whSecret)}, 'USD')`;
  } else {
    await sql`INSERT INTO finance_settings (workspace_id, stripe_connect_user_id, stripe_onboarding_status, currency)
      VALUES (${wid}, ${acct}, 'complete', 'USD')`;
  }
  return { uid: u, wid, acct, whSecret, cookie: cookieFor(u), name: `${label} Studio` };
}
// A client user who signed in to the portal (clients.user_id linked).
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
  const cleanupWorkspaces = [A.wid, B.wid];

  // ════════════════════════════════════════════════════════════════════
  console.log('\n[1] owner: create / edit / publish / archive, validation, isolation');
  let r = await call(programsIndex, req({ method: 'POST', cookie: A.cookie, body: { title: '', priceCents: 1000 } }));
  assert(r.statusCode === 400 && /title/i.test(r.body.error), 'missing title → 400');
  r = await call(programsIndex, req({ method: 'POST', cookie: A.cookie, body: { title: 'X', priceCents: -500 } }));
  assert(r.statusCode === 400 && /price/i.test(r.body.error), 'negative price → 400');
  r = await call(programsIndex, req({ method: 'POST', cookie: A.cookie, body: { title: 'X', priceCents: 'abc' } }));
  assert(r.statusCode === 400, 'non-numeric price → 400');
  r = await call(programsIndex, req({ method: 'POST', cookie: A.cookie, body: { title: 'X', priceCents: 1000, billing: 'weekly' } }));
  assert(r.statusCode === 400 && /billing/i.test(r.body.error), 'unknown billing → 400');
  r = await call(programsIndex, req({ method: 'POST', cookie: A.cookie, body: { title: 'X', priceCents: 1000, accessDays: 0 } }));
  assert(r.statusCode === 400 && /access/i.test(r.body.error), 'accessDays 0 → 400');
  r = await call(programsIndex, req({ method: 'POST', cookie: A.cookie, body: { title: 'X', priceCents: 1000, accessDays: 5000 } }));
  assert(r.statusCode === 400, 'accessDays 5000 → 400');
  r = await call(programsIndex, req({ method: 'POST', body: { title: 'X', priceCents: 1000 } }));
  assert(r.statusCode === 401, 'unauthenticated create → 401');

  r = await call(programsIndex, req({ method: 'POST', cookie: A.cookie, body: { title: '8-Week Strength', description: 'Lift.', priceCents: 4900, billing: 'one_time', accessDays: 56, communityEnabled: true } }));
  assert(r.statusCode === 201 && r.body.program?.status === 'draft' && r.body.program.accessDays === 56 && r.body.program.priceCents === 4900, 'one-time program created as a draft');
  const oneTime = r.body.program;
  r = await call(programsIndex, req({ method: 'POST', cookie: A.cookie, body: { title: 'Monthly Coaching', priceCents: 2900, billing: 'month', accessDays: 30 } }));
  assert(r.statusCode === 201 && r.body.program?.billing === 'month', 'monthly subscription program created');
  const monthly = r.body.program;
  r = await call(programsIndex, req({ method: 'POST', cookie: A.cookie, body: { title: 'Free Guide', priceCents: 0 } }));
  const free = r.body.program;
  assert(r.statusCode === 201 && free.priceCents === 0, 'free program created');

  r = await call(programById, req({ method: 'PATCH', cookie: A.cookie, query: { id: oneTime.id }, body: { title: '8-Week Strength Foundations', accessDays: 60 } }));
  assert(r.statusCode === 200 && r.body.program.title === '8-Week Strength Foundations' && r.body.program.accessDays === 60 && r.body.program.priceCents === 4900, 'PATCH edits title + access window, keeps price');
  r = await call(programById, req({ method: 'PATCH', cookie: A.cookie, query: { id: oneTime.id }, body: { priceCents: -1 } }));
  assert(r.statusCode === 400, 'PATCH negative price → 400');
  r = await call(programById, req({ method: 'PATCH', cookie: A.cookie, query: { id: oneTime.id }, body: { status: 'live' } }));
  assert(r.statusCode === 400, 'PATCH unknown status → 400');
  for (const p of [oneTime, monthly, free]) {
    r = await call(programById, req({ method: 'PATCH', cookie: A.cookie, query: { id: p.id }, body: { status: 'published' } }));
    assert(r.statusCode === 200 && r.body.program.status === 'published', `publish ${p.title}`);
  }

  r = await call(programItems, req({ method: 'POST', cookie: A.cookie, query: { id: oneTime.id }, body: { type: 'post', title: 'Week 1', body: '' } }));
  assert(r.statusCode === 400, 'lesson without text → 400');
  r = await call(programItems, req({ method: 'POST', cookie: A.cookie, query: { id: oneTime.id }, body: { type: 'pdf', title: 'Plan', fileUrl: 'https://evil.example.com/x.pdf' } }));
  assert(r.statusCode === 400, 'PDF from a non-blob host → 400');
  r = await call(programItems, req({ method: 'POST', cookie: A.cookie, query: { id: oneTime.id }, body: { type: 'video', title: 'Intro', youtube: 'https://vimeo.com/123' } }));
  assert(r.statusCode === 400, 'non-YouTube video link → 400');
  r = await call(programItems, req({ method: 'POST', cookie: A.cookie, query: { id: oneTime.id }, body: { type: 'post', title: 'Week 1', body: 'Squat **heavy**.' } }));
  assert(r.statusCode === 201 && r.body.item.type === 'post', 'lesson added');
  r = await call(programItems, req({ method: 'POST', cookie: A.cookie, query: { id: oneTime.id }, body: { type: 'video', title: 'Intro', youtube: 'https://youtu.be/dQw4w9WgXcQ' } }));
  assert(r.statusCode === 201 && r.body.item.youtubeId === 'dQw4w9WgXcQ', 'video added from a youtu.be link');

  r = await call(programsIndex, req({ cookie: A.cookie }));
  assert(r.statusCode === 200 && r.body.programs.length === 3 && r.body.programs.find((p) => p.id === oneTime.id)?.items === 2, 'owner list shows 3 programs with item counts');

  // Workspace isolation: owner B cannot read, change or archive A's program.
  r = await call(programById, req({ cookie: B.cookie, query: { id: oneTime.id } }));
  assert(r.statusCode === 404, "other owner GET → 404");
  r = await call(programById, req({ method: 'PATCH', cookie: B.cookie, query: { id: oneTime.id }, body: { title: 'Hijacked' } }));
  assert(r.statusCode === 404, 'other owner PATCH → 404');
  r = await call(programById, req({ method: 'DELETE', cookie: B.cookie, query: { id: oneTime.id } }));
  assert(r.statusCode === 404, 'other owner DELETE → 404');
  r = await call(programItems, req({ method: 'POST', cookie: B.cookie, query: { id: oneTime.id }, body: { type: 'post', title: 'x', body: 'y' } }));
  assert(r.statusCode === 404, 'other owner cannot add content');
  r = await call(programMembers, req({ method: 'POST', cookie: B.cookie, query: { id: oneTime.id }, body: { email: 'x@example.com' } }));
  assert(r.statusCode === 404, 'other owner cannot add members');
  assert((await sql`SELECT title, status FROM programs WHERE id = ${oneTime.id}`).rows[0].title === '8-Week Strength Foundations', "A's program untouched");
  r = await call(programsIndex, req({ cookie: B.cookie }));
  assert(r.body.programs.length === 0, "B's list is empty");

  // Archive: no new sales, excluded from the list, cannot be re-published.
  r = await call(programsIndex, req({ method: 'POST', cookie: A.cookie, body: { title: 'Old Course', priceCents: 1000 } }));
  const old = r.body.program;
  r = await call(programById, req({ method: 'DELETE', cookie: A.cookie, query: { id: old.id } }));
  assert(r.statusCode === 200 && r.body.archived === true, 'archive → ok');
  r = await call(programsIndex, req({ cookie: A.cookie }));
  assert(!r.body.programs.some((p) => p.id === old.id), 'archived program leaves the owner list');
  r = await call(programPublic, req({ query: { id: old.id } }));
  assert(r.statusCode === 404, 'archived program has no public page');
  r = await call(programById, req({ method: 'PATCH', cookie: A.cookie, query: { id: old.id }, body: { status: 'published' } }));
  assert(r.statusCode === 400 && /archived/i.test(r.body.error), 'archived program cannot be published');

  // ════════════════════════════════════════════════════════════════════
  console.log('\n[2] one-time purchase');
  r = await call(programPublic, req({ query: { id: oneTime.id } }));
  assert(r.statusCode === 200 && r.body.program.priceCents === 4900 && r.body.business.name === A.name && r.body.currency === 'USD', 'public page: price, business, currency');
  assert(r.body.outline.length === 2 && r.body.outline.every((o) => o.body === undefined && o.youtubeId === undefined), 'public outline has titles only, no content');
  r = await call(programPublic, req({ query: { id: 'not-a-uuid' } }));
  assert(r.statusCode === 404, 'unknown program → 404');

  const buyer = { name: 'Casey Client', email: `pe-casey-${STAMP}@example.com` };
  r = await call(programCheckout, req({ method: 'POST', body: { programId: oneTime.id, email: buyer.email } }));
  assert(r.statusCode === 400 && /name/i.test(r.body.error), 'checkout without a name → 400');
  r = await call(programCheckout, req({ method: 'POST', body: { programId: oneTime.id, name: 'x', email: 'nope' } }));
  assert(r.statusCode === 400 && /email/i.test(r.body.error), 'checkout with a bad email → 400');
  r = await call(programCheckout, req({ method: 'POST', body: { programId: free.id, ...buyer } }));
  assert(r.statusCode === 400 && /free/i.test(r.body.error), 'free program cannot be bought');
  r = await call(programCheckout, req({ method: 'POST', body: { programId: old.id, ...buyer } }));
  assert(r.statusCode === 404, 'archived program cannot be bought');

  calls.length = 0;
  r = await call(programCheckout, req({ method: 'POST', body: { programId: oneTime.id, ...buyer } }));
  assert(r.statusCode === 200 && /checkout\.stripe\.com/.test(r.body.url), `checkout returns a Stripe URL (got ${r.statusCode} ${JSON.stringify(r.body)})`);
  const cust = lastStripe(/POST .*\/v1\/customers$/);
  assert(!!cust && cust.body.email === buyer.email && cust.headers['Stripe-Account'] === A.acct, 'Stripe customer created on the connected account');
  const cs = lastStripe(/POST .*\/v1\/checkout\/sessions$/);
  assert(!!cs && cs.headers['Stripe-Account'] === A.acct && cs.headers.Authorization === 'Bearer sk_test_programs', 'checkout session minted as a direct charge on the connected account (platform key + Stripe-Account)');
  assert(cs.body.mode === 'payment' && cs.body['line_items[0][price_data][unit_amount]'] === '4900' && cs.body['line_items[0][price_data][currency]'] === 'usd', 'mode=payment, amount 4900 usd');
  const client = (await sql`SELECT * FROM clients WHERE workspace_id = ${A.wid} AND email = ${buyer.email}`).rows[0];
  assert(!!client && client.stage === 'lead' && client.source === 'program' && String(client.stripe_customer_id).startsWith('cus_'), 'client row created as a program lead with the Stripe customer id');
  assert(cs.body['metadata[purpose]'] === 'program' && cs.body['metadata[program_id]'] === oneTime.id && cs.body['metadata[client_id]'] === client.id && cs.body['metadata[workspace_id]'] === A.wid, 'session metadata: purpose/program_id/client_id/workspace_id');
  assert(cs.body['payment_intent_data[metadata][purpose]'] === 'program' && cs.body['payment_intent_data[metadata][program_id]'] === oneTime.id, 'payment intent metadata mirrors the session');
  assert(cs.body.success_url.includes(`/p/${oneTime.id}?purchased=1`) && cs.body.cancel_url.includes('cancelled=1'), 'success/cancel URLs return to the sales page');
  assert(!('subscription_data[metadata][purpose]' in cs.body), 'no subscription_data on a one-time session');

  calls.length = 0;
  r = await call(programCheckout, req({ method: 'POST', body: { programId: oneTime.id, name: 'Casey Again', email: buyer.email.toUpperCase() }, ip: `${IPB}.6` }));
  assert(r.statusCode === 200, 'second checkout for the same email (different case) works');
  assert((await sql`SELECT COUNT(*)::int n FROM clients WHERE workspace_id = ${A.wid} AND LOWER(email) = ${buyer.email}`).rows[0].n === 1, 'no duplicate client row');
  assert(stripeCalls(/\/v1\/customers/).length === 0, 'stored Stripe customer reused (no customer lookup)');

  const session = (id, over = {}) => ({
    id, mode: 'payment', status: 'complete', payment_status: 'paid', amount_total: 4900, payment_intent: `pi_${id}`,
    customer: client.stripe_customer_id, payment_method_types: ['card'],
    metadata: { workspace_id: A.wid, program_id: oneTime.id, client_id: client.id, purpose: 'program' },
    ...over,
  });

  // Unpaid (ACH still settling) grants nothing.
  r = await fire('checkout.session.completed', session('cs_ach_1', { payment_status: 'unpaid', payment_method_types: ['us_bank_account'] }), A.acct);
  assert(r.statusCode === 200 && /awaiting settlement/.test(r.body.ignored || ''), `unpaid completed session is not fulfilled (got ${JSON.stringify(r.body)})`);
  assert(!(await enrollment(oneTime.id, client.id)), 'no enrollment before the money clears');
  // ... and the settlement event grants.
  r = await fire('checkout.session.async_payment_succeeded', session('cs_ach_1'), A.acct);
  assert(r.statusCode === 200 && r.body.applied === 'program-purchase' && !r.body.duplicate, `async_payment_succeeded grants access (got ${JSON.stringify(r.body)})`);
  let e = await enrollment(oneTime.id, client.id);
  assert(e && e.status === 'active' && e.source === 'purchase' && e.stripe_session_id === 'cs_ach_1' && e.stripe_payment_intent === 'pi_cs_ach_1', 'enrollment active, purchase source, session + payment intent recorded');
  const daysLeft = (new Date(e.expires_at) - Date.now()) / 86400_000;
  assert(daysLeft > 59.9 && daysLeft < 60.1, `access expires in 60 days (got ${daysLeft.toFixed(2)})`);
  // Redelivered / duplicated event for the same session is a no-op.
  r = await fire('checkout.session.completed', session('cs_ach_1'), A.acct);
  assert(r.statusCode === 200 && r.body.duplicate === true, 'duplicate webhook for the same session is a no-op');
  assert((await sql`SELECT COUNT(*)::int n FROM program_enrollments WHERE program_id = ${oneTime.id} AND client_id = ${client.id}`).rows[0].n === 1, 'still one enrollment');
  // Metadata for another workspace is refused outright.
  r = await fire('checkout.session.completed', session('cs_x', { metadata: { workspace_id: B.wid, program_id: oneTime.id, client_id: client.id, purpose: 'program' } }), A.acct);
  assert(r.statusCode === 400, 'session whose metadata names another workspace → 400');
  // A program id from another workspace never grants.
  r = await call(programsIndex, req({ method: 'POST', cookie: B.cookie, body: { title: 'B Course', priceCents: 1000 } }));
  const bProgram = r.body.program;
  r = await fire('checkout.session.completed', session('cs_cross', { metadata: { workspace_id: A.wid, program_id: bProgram.id, client_id: client.id, purpose: 'program' } }), A.acct);
  assert(r.body.ignored === 'program or client not found', "cannot grant another workspace's program through A's account");

  // Client portal.
  const casey = await mkClientUser('Casey Client', A.wid, buyer.email);
  // The portal user and the purchase share the clients row (same email): link them.
  await sql`UPDATE clients SET user_id = ${casey.uid} WHERE id = ${client.id}`;
  await sql`DELETE FROM clients WHERE id = ${casey.cid}`;
  casey.cid = client.id;
  cleanupUsers.push(casey.uid);
  r = await call(mePrograms, req({ cookie: casey.cookie }));
  assert(r.statusCode === 200 && r.body.programs.length === 1, 'client portal lists the purchased program');
  let mine = r.body.programs[0];
  assert(mine.id === oneTime.id && mine.businessName === A.name && mine.items === 2 && mine.enrollmentStatus === 'active', 'card: business, item count, active');
  assert(!!mine.expiresAt && mine.accessUntil === mine.expiresAt && mine.canCancel === false && mine.cancelAtPeriodEnd === false, 'card: Access until <expiry>, nothing to cancel');
  r = await call(meProgram, req({ cookie: casey.cookie, query: { id: oneTime.id } }));
  assert(r.statusCode === 200 && r.body.role === 'member' && r.body.items.length === 2 && r.body.items[0].body === 'Squat **heavy**.', 'program content is readable by the member');
  r = await call(meProgram, req({ query: { id: oneTime.id } }));
  assert(r.statusCode === 401, 'anonymous → 401');
  const dana = await mkClientUser('Dana Other', B.wid, `pe-dana-${STAMP}@example.com`);
  cleanupUsers.push(dana.uid);
  r = await call(mePrograms, req({ cookie: dana.cookie }));
  assert(r.body.programs.length === 0, "a client of workspace B sees none of A's programs");
  r = await call(meProgram, req({ cookie: dana.cookie, query: { id: oneTime.id } }));
  assert(r.statusCode === 403, "a client of B cannot open A's program");
  r = await call(meProgram, req({ cookie: B.cookie, query: { id: oneTime.id } }));
  assert(r.statusCode === 403, "owner B cannot open A's program through the portal");
  r = await call(meProgram, req({ cookie: A.cookie, query: { id: oneTime.id } }));
  assert(r.statusCode === 200 && r.body.role === 'owner', 'owner A opens it as owner');
  r = await call(meProgramSub, req({ method: 'DELETE', cookie: casey.cookie, query: { id: oneTime.id } }));
  assert(r.statusCode === 400 && /not on a subscription/i.test(r.body.error), 'cancelling a one-time purchase is refused');

  // Owner sees the member.
  r = await call(programById, req({ cookie: A.cookie, query: { id: oneTime.id } }));
  assert(r.body.members.length === 1 && r.body.members[0].clientEmail === buyer.email && r.body.members[0].source === 'purchase' && r.body.program.members === 1, 'owner member list shows the buyer');

  // Access window runs out: the cron closes it.
  r = await call(programAccessCron, req({ headers: {} }));
  assert(r.statusCode === 401, 'cron without the secret → 401');
  await sql`UPDATE program_enrollments SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = ${e.id}`;
  r = await call(programAccessCron, { method: 'GET', url: '/api/cron/program-access', headers: { authorization: `Bearer ${process.env.CRON_SECRET}` }, query: {} });
  assert(r.statusCode === 200 && r.body.expired >= 1, `cron expires lapsed access (got ${JSON.stringify(r.body)})`);
  e = await enrollment(oneTime.id, client.id);
  assert(e.status === 'cancelled' && !!e.cancelled_at, 'enrollment closed');
  r = await call(mePrograms, req({ cookie: casey.cookie }));
  assert(r.body.programs.length === 0, 'portal no longer lists it');
  r = await call(meProgram, req({ cookie: casey.cookie, query: { id: oneTime.id } }));
  assert(r.statusCode === 403, 'content is locked after expiry');
  r = await call(programById, req({ cookie: A.cookie, query: { id: oneTime.id } }));
  assert(r.body.program.members === 0 && r.body.members[0].status === 'cancelled', 'owner sees 0 active members, history kept');

  // Buying again re-opens the same enrollment with a fresh window.
  r = await fire('checkout.session.completed', session('cs_again'), A.acct);
  assert(r.body.applied === 'program-purchase' && !r.body.duplicate, 're-purchase grants again');
  e = await enrollment(oneTime.id, client.id);
  assert(e.status === 'active' && e.stripe_session_id === 'cs_again' && new Date(e.expires_at) > new Date(Date.now() + 59 * 86400_000), 'fresh 60-day window, new session id');
  r = await call(mePrograms, req({ cookie: casey.cookie }));
  assert(r.body.programs.length === 1, 'portal lists it again');

  // Dashboard refund: partial keeps access, full closes it.
  r = await fire('charge.refunded', { id: 'ch_1', payment_intent: 'pi_cs_again', amount: 4900, amount_refunded: 1000 }, A.acct);
  assert(r.body.applied === 'program-refund' && r.body.result === 'partial', `partial refund recorded (got ${JSON.stringify(r.body)})`);
  assert((await enrollment(oneTime.id, client.id)).status === 'active', 'partial refund keeps access');
  r = await fire('charge.refunded', { id: 'ch_1', payment_intent: 'pi_cs_again', amount: 4900, amount_refunded: 4900 }, A.acct);
  assert(r.body.applied === 'program-refund' && r.body.result === 'revoked', 'full refund revokes');
  assert((await enrollment(oneTime.id, client.id)).status === 'cancelled', 'enrollment closed by the refund');
  r = await fire('charge.refunded', { id: 'ch_1', payment_intent: 'pi_cs_again', amount: 4900, amount_refunded: 4900 }, A.acct);
  assert(r.body.result === 'already-cancelled', 'refund echo is a no-op');
  r = await call(mePrograms, req({ cookie: casey.cookie }));
  assert(r.body.programs.length === 0, 'portal: refunded purchase is gone');
  // A charge with no stored PI still matches through the metadata Stripe copies onto it.
  r = await fire('checkout.session.completed', session('cs_md', { payment_intent: null }), A.acct);
  assert(r.body.applied === 'program-purchase', 'purchase without a PI id still grants');
  r = await fire('charge.refunded', { id: 'ch_2', payment_intent: 'pi_unknown', amount: 4900, amount_refunded: 4900, metadata: { purpose: 'program', program_id: oneTime.id, client_id: client.id, workspace_id: A.wid } }, A.acct);
  assert(r.body.result === 'revoked', 'refund matched through charge metadata');
  r = await fire('charge.refunded', { id: 'ch_3', payment_intent: 'pi_nothing', amount: 100, amount_refunded: 100 }, A.acct);
  assert(r.body.ignored === 'no purchase for payment_intent', 'unrelated refund is acknowledged and ignored');

  // Manual grant by the owner (free / paid elsewhere).
  r = await call(programMembers, req({ method: 'POST', cookie: A.cookie, query: { id: free.id }, body: { name: 'Casey', email: buyer.email } }));
  assert(r.statusCode === 201 && r.body.clientId === client.id && !!r.body.enrollmentId, 'owner adds an existing client by email (no duplicate client)');
  r = await call(mePrograms, req({ cookie: casey.cookie }));
  assert(r.body.programs.some((p) => p.id === free.id && !p.expiresAt && p.canCancel === false), 'manual grant shows in the portal with lifetime access');
  r = await call(programMembers, req({ method: 'DELETE', cookie: A.cookie, query: { id: free.id, enrollmentId: r.body.programs.find((p) => p.id === free.id).enrollmentId } }));
  assert(r.statusCode === 200 && r.body.revoked === true && r.body.subscriptionCancelled === false, 'owner revokes a manual grant');
  r = await call(mePrograms, req({ cookie: casey.cookie }));
  assert(!r.body.programs.some((p) => p.id === free.id), 'revoked grant leaves the portal');

  // ════════════════════════════════════════════════════════════════════
  console.log('\n[3] subscription program');
  calls.length = 0;
  r = await call(programCheckout, req({ method: 'POST', body: { programId: monthly.id, ...buyer }, ip: `${IPB}.7` }));
  assert(r.statusCode === 200, 'subscription checkout → URL');
  const scs = lastStripe(/POST .*\/v1\/checkout\/sessions$/);
  assert(scs.body.mode === 'subscription' && scs.body['line_items[0][price_data][recurring][interval]'] === 'month' && scs.body['line_items[0][price_data][unit_amount]'] === '2900', 'mode=subscription with an inline monthly price');
  assert(scs.body['subscription_data[metadata][purpose]'] === 'program' && scs.body['subscription_data[metadata][program_id]'] === monthly.id && scs.body['subscription_data[metadata][client_id]'] === client.id && scs.body['subscription_data[metadata][workspace_id]'] === A.wid, 'subscription metadata stamped for the webhook');
  assert(!Object.keys(scs.body).some((k) => k.startsWith('payment_intent_data')), 'no payment_intent_data in subscription mode');

  const subId = `sub_pe_${STAMP}`;
  const subMd = { workspace_id: A.wid, program_id: monthly.id, client_id: client.id, purpose: 'program' };
  const cpe1 = Math.floor(Date.now() / 1000) + 30 * 86400;
  // subscription.created lands (possibly before checkout.session.completed, which is ignored in subscription mode).
  r = await fire('customer.subscription.created', subObj(subId, { metadata: subMd, current_period_end: cpe1 }), A.acct);
  assert(r.statusCode === 200 && r.body.applied === 'program-subscription' && r.body.result === 'applied', `subscription.created grants (got ${JSON.stringify(r.body)})`);
  e = await enrollment(monthly.id, client.id);
  assert(e && e.status === 'active' && e.source === 'subscription' && e.stripe_subscription_id === subId && Math.abs(new Date(e.current_period_end).getTime() / 1000 - cpe1) < 2, 'enrollment active with the period end');
  r = await fire('checkout.session.completed', { id: 'cs_sub_1', mode: 'subscription', payment_status: 'paid', subscription: subId, metadata: { ...subMd } }, A.acct);
  assert(r.statusCode === 200 && (await sql`SELECT COUNT(*)::int n FROM program_enrollments WHERE program_id = ${monthly.id} AND client_id = ${client.id}`).rows[0].n === 1, 'the late checkout.session.completed does not double-grant');
  r = await fire('customer.subscription.created', subObj(subId, { metadata: subMd, current_period_end: cpe1 }), A.acct);
  assert((await sql`SELECT COUNT(*)::int n FROM program_enrollments WHERE stripe_subscription_id = ${subId}`).rows[0].n === 1, 'duplicate subscription.created keeps one row');
  r = await call(mePrograms, req({ cookie: casey.cookie }));
  mine = r.body.programs.find((p) => p.id === monthly.id);
  assert(mine && mine.canCancel === true && mine.cancelAtPeriodEnd === false && !mine.accessUntil && !!mine.currentPeriodEnd, 'portal: renews <date>, Cancel available');

  // Renewal.
  const cpe2 = cpe1 + 30 * 86400;
  r = await fire('customer.subscription.updated', subObj(subId, { metadata: subMd, current_period_end: cpe2 }), A.acct);
  e = await enrollment(monthly.id, client.id);
  assert(e.status === 'active' && Math.abs(new Date(e.current_period_end).getTime() / 1000 - cpe2) < 2, 'renewal moves the period end forward, access continues');

  // Client cancels at period end.
  r = await call(meProgramSub, req({ method: 'DELETE', cookie: casey.cookie, query: { id: monthly.id }, origin: 'https://evil.example.com' }));
  assert(r.statusCode === 403, 'cancel from a foreign origin is refused (CSRF)');
  r = await call(meProgramSub, req({ method: 'DELETE', cookie: dana.cookie, query: { id: monthly.id } }));
  assert(r.statusCode === 404, "another business's client cannot cancel it");
  calls.length = 0;
  r = await call(meProgramSub, req({ method: 'DELETE', cookie: casey.cookie, query: { id: monthly.id } }));
  assert(r.statusCode === 200 && r.body.cancelled && r.body.atPeriodEnd && !!r.body.accessUntil, `client cancels at period end (got ${JSON.stringify(r.body)})`);
  let sc = lastStripe(new RegExp(`POST .*/v1/subscriptions/${subId}$`));
  assert(!!sc && sc.body.cancel_at_period_end === 'true' && sc.headers['Stripe-Account'] === A.acct, 'Stripe told to cancel at period end on the connected account');
  e = await enrollment(monthly.id, client.id);
  assert(e.status === 'active' && e.cancel_at_period_end === true, 'locally: still active, auto-renew off');
  r = await call(mePrograms, req({ cookie: casey.cookie }));
  mine = r.body.programs.find((p) => p.id === monthly.id);
  assert(mine.cancelAtPeriodEnd === true && mine.canCancel === false && mine.accessUntil && Math.abs(new Date(mine.accessUntil).getTime() / 1000 - cpe2) < 2, 'portal: Access until <period end>, no Cancel button');
  calls.length = 0;
  r = await call(meProgramSub, req({ method: 'DELETE', cookie: casey.cookie, query: { id: monthly.id } }));
  assert(r.statusCode === 200 && r.body.alreadyScheduled === true && stripeCalls(/subscriptions/).length === 0, 'second cancel is a no-op (no Stripe call)');
  // Stripe echoes the change.
  r = await fire('customer.subscription.updated', subObj(subId, { metadata: subMd, current_period_end: cpe2, cancel_at_period_end: true }), A.acct);
  e = await enrollment(monthly.id, client.id);
  assert(e.status === 'active' && e.cancel_at_period_end === true, 'webhook keeps access live until the period end');
  r = await call(meProgram, req({ cookie: casey.cookie, query: { id: monthly.id } }));
  assert(r.statusCode === 200, 'content still readable until the period ends');
  // The client changes their mind in the Stripe portal: auto-renew back on.
  r = await fire('customer.subscription.updated', subObj(subId, { metadata: subMd, current_period_end: cpe2, cancel_at_period_end: false }), A.acct);
  r = await call(mePrograms, req({ cookie: casey.cookie }));
  mine = r.body.programs.find((p) => p.id === monthly.id);
  assert(mine.cancelAtPeriodEnd === false && mine.canCancel === true, 'reactivation flips Cancel back on');

  // Payment failure: past_due, both sides told once.
  emails.length = 0;
  r = await fire('customer.subscription.updated', subObj(subId, { metadata: subMd, current_period_end: cpe2, status: 'past_due' }), A.acct);
  e = await enrollment(monthly.id, client.id);
  assert(e.status === 'past_due', 'failed renewal → past_due');
  await settle();
  const failMail = emails.find((m) => /Payment failed/.test(m.subject || ''));
  assert(!!failMail && (failMail.to || []).includes(buyer.email) && /Monthly Coaching/.test(failMail.subject), `client emailed about the failed payment (got ${emails.map((m) => m.subject).join(' | ')})`);
  assert(/\/me\/billing/.test(failMail?.html || ''), 'email points at the Billing page');
  r = await call(mePrograms, req({ cookie: casey.cookie }));
  mine = r.body.programs.find((p) => p.id === monthly.id);
  assert(mine && mine.enrollmentStatus === 'past_due', 'portal still lists it, flagged past due');
  r = await call(programById, req({ cookie: A.cookie, query: { id: monthly.id } }));
  assert(r.body.members.find((m) => m.clientId === client.id)?.status === 'past_due' && r.body.program.members === 1, 'owner member list shows past due, still counted');
  emails.length = 0;
  r = await fire('customer.subscription.updated', subObj(subId, { metadata: subMd, current_period_end: cpe2, status: 'past_due' }), A.acct);
  await settle();
  assert(emails.length === 0, 'a repeated past_due event does not email again');
  r = await fire('customer.subscription.updated', subObj(subId, { metadata: subMd, current_period_end: cpe2, status: 'paused' }), A.acct);
  assert((await enrollment(monthly.id, client.id)).status === 'past_due', 'paused is not entitled (past_due)');
  r = await fire('customer.subscription.updated', subObj(subId, { metadata: subMd, current_period_end: cpe2, status: 'active' }), A.acct);
  assert((await enrollment(monthly.id, client.id)).status === 'active', 'recovered payment → active again');

  // Deleted: access ends.
  r = await fire('customer.subscription.deleted', subObj(subId, { metadata: subMd, current_period_end: cpe2, status: 'canceled' }), A.acct);
  e = await enrollment(monthly.id, client.id);
  assert(e.status === 'cancelled' && !!e.cancelled_at, 'subscription.deleted revokes');
  r = await call(mePrograms, req({ cookie: casey.cookie }));
  assert(!r.body.programs.some((p) => p.id === monthly.id), 'portal no longer lists it');
  r = await call(meProgram, req({ cookie: casey.cookie, query: { id: monthly.id } }));
  assert(r.statusCode === 403, 'content locked');
  r = await call(programById, req({ cookie: A.cookie, query: { id: monthly.id } }));
  assert(r.body.program.members === 0 && r.body.members[0].status === 'cancelled', 'owner sees the cancelled member in history');

  // Owner revokes a live subscription member: Stripe subscription is cancelled too.
  const sub2 = `sub_pe2_${STAMP}`;
  r = await fire('customer.subscription.created', subObj(sub2, { metadata: subMd, current_period_end: cpe2 }), A.acct);
  e = await enrollment(monthly.id, client.id);
  assert(e.status === 'active' && e.stripe_subscription_id === sub2, 're-subscribed (new subscription id)');
  stripeFail = { pattern: new RegExp(`DELETE .*/v1/subscriptions/${sub2}$`), status: 500, message: 'Stripe is down' };
  r = await call(programMembers, req({ method: 'DELETE', cookie: A.cookie, query: { id: monthly.id, enrollmentId: e.id } }));
  assert(r.statusCode === 400 && /Stripe/.test(r.body.error) && (await enrollment(monthly.id, client.id)).status === 'active', 'if Stripe cannot cancel, access is NOT revoked (client would keep paying)');
  stripeFail = null;
  calls.length = 0;
  r = await call(programMembers, req({ method: 'DELETE', cookie: A.cookie, query: { id: monthly.id, enrollmentId: e.id } }));
  assert(r.statusCode === 200 && r.body.revoked && r.body.subscriptionCancelled === true, `owner revoke cancels the subscription (got ${JSON.stringify(r.body)})`);
  sc = lastStripe(new RegExp(`DELETE .*/v1/subscriptions/${sub2}$`));
  assert(!!sc && sc.headers['Stripe-Account'] === A.acct, 'Stripe subscription cancelled immediately on the connected account');
  assert((await enrollment(monthly.id, client.id)).status === 'cancelled', 'access revoked');
  r = await fire('customer.subscription.deleted', subObj(sub2, { metadata: subMd, status: 'canceled' }), A.acct);
  assert((await enrollment(monthly.id, client.id)).status === 'cancelled', 'the deleted echo keeps it cancelled');
  r = await call(programMembers, req({ method: 'DELETE', cookie: A.cookie, query: { id: monthly.id, enrollmentId: e.id } }));
  assert(r.statusCode === 200 && r.body.alreadyCancelled === true, 'revoking twice is a no-op');
  r = await call(programMembers, req({ method: 'DELETE', cookie: A.cookie, query: { id: monthly.id, enrollmentId: '00000000-0000-4000-8000-000000000000' } }));
  assert(r.statusCode === 404, 'unknown enrollment → 404');

  // Status mapping for a subscription that never got paid.
  const sub3 = `sub_pe3_${STAMP}`;
  r = await fire('customer.subscription.created', subObj(sub3, { metadata: subMd, status: 'incomplete' }), A.acct);
  assert((await enrollment(monthly.id, client.id)).status === 'cancelled', 'incomplete subscription grants nothing');
  r = await fire('customer.subscription.updated', subObj(sub3, { metadata: subMd, status: 'active' }), A.acct);
  assert((await enrollment(monthly.id, client.id)).status === 'active', 'first payment lands → active');
  r = await fire('customer.subscription.deleted', subObj(sub3, { metadata: subMd, status: 'canceled' }), A.acct);

  // Cross-workspace subscription metadata is refused.
  r = await fire('customer.subscription.created', subObj('sub_cross', { metadata: { ...subMd, workspace_id: B.wid } }), A.acct);
  assert(r.statusCode === 400, 'subscription naming another workspace → 400');
  r = await fire('customer.subscription.created', subObj('sub_cross2', { metadata: { ...subMd, program_id: bProgram.id } }), A.acct);
  assert(r.body.result === 'missing' && !(await enrollment(bProgram.id, client.id)), "cannot grant B's program through A's account");

  // Legacy per-workspace webhook (owner pasted their own keys).
  const L = await mkOwner('legacy', { legacy: true });
  cleanupUsers.push(L.uid); cleanupWorkspaces.push(L.wid);
  r = await call(programsIndex, req({ method: 'POST', cookie: L.cookie, body: { title: 'Legacy Monthly', priceCents: 1500, billing: 'month' } }));
  const lProg = r.body.program;
  const lClient = (await sql`INSERT INTO clients (workspace_id, name, email, stage) VALUES (${L.wid}, 'Lee', ${`pe-lee-${STAMP}@example.com`}, 'lead') RETURNING id`).rows[0].id;
  const lMd = { workspace_id: L.wid, program_id: lProg.id, client_id: lClient, purpose: 'program' };
  r = await fireLegacy('customer.subscription.created', subObj('sub_legacy_1', { metadata: lMd }), L.wid, L.whSecret);
  assert(r.statusCode === 200 && r.body.applied === 'program-subscription' && r.body.result === 'applied', `legacy webhook grants a program subscription (got ${JSON.stringify(r.body)})`);
  assert((await enrollment(lProg.id, lClient))?.status === 'active', 'legacy: enrollment active');
  r = await fireLegacy('customer.subscription.deleted', subObj('sub_legacy_1', { metadata: lMd, status: 'canceled' }), L.wid, L.whSecret);
  assert((await enrollment(lProg.id, lClient))?.status === 'cancelled', 'legacy: deleted revokes');
  r = await fireLegacy('checkout.session.completed', { id: 'cs_legacy_1', mode: 'payment', status: 'complete', payment_status: 'paid', amount_total: 1500, payment_intent: 'pi_legacy_1', metadata: { workspace_id: L.wid, program_id: lProg.id, client_id: lClient, purpose: 'program' } }, L.wid, L.whSecret);
  assert(r.statusCode === 200 && r.body.applied === 'program-purchase', `legacy webhook fulfils a one-time program purchase (got ${JSON.stringify(r.body)})`);

  // ════════════════════════════════════════════════════════════════════
  console.log('\n[4] archived business refuses new purchases');
  await sql`UPDATE workspaces SET subscription_status = 'cancelled', subscription_period_end = NOW() - INTERVAL '1 day' WHERE id = ${A.wid}`;
  r = await call(programCheckout, req({ method: 'POST', body: { programId: oneTime.id, ...buyer }, ip: `${IPB}.8` }));
  assert(r.statusCode === 403 && r.body.code === 'business_archived', 'lapsed business: program checkout → 403');
  r = await call(programPublic, req({ query: { id: oneTime.id } }));
  assert(r.statusCode === 200 && r.body.archived === true && !r.body.program, 'lapsed business: sales page shows the archived card, no program');
  await sql`UPDATE workspaces SET subscription_status = 'active', subscription_period_end = NOW() + INTERVAL '30 days' WHERE id = ${A.wid}`;
  r = await call(programPublic, req({ query: { id: oneTime.id } }));
  assert(r.statusCode === 200 && !!r.body.program, 'resubscribed: sales page is back');

  // ════════════════════════════════════════════════════════════════════
  console.log('\n[5] user-facing copy');
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const files = [
    'src/features/programs/ProgramsPage.jsx', 'src/features/programs/ProgramContent.jsx', 'src/features/programs/PublicProgram.jsx',
    'src/features/client/ClientPrograms.jsx', 'src/features/client/ClientBilling.jsx', 'src/features/finance/Memberships.jsx',
    'api/_lib/programs.js', 'api/_lib/clientSubscriptionNotify.js', 'api/programs/checkout.js', 'api/memberships/checkout.js',
    'api/programs/[id]/items.js', 'api/programs/[id]/members.js', 'api/me/programs/[id]/subscription.js', 'api/me/memberships/[id].js',
  ];
  for (const f of files) {
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    assert(!text.includes('—'), `${f}: no em dashes`);
    assert(!/business os/i.test(text) && !/\b(Claude|Anthropic)\b/.test(text), `${f}: no "business OS", no vendor names`);
  }
  const welcome = fs.readFileSync(path.join(root, 'api/_lib/welcome-content.js'), 'utf8');
  assert(!/business os/i.test(welcome), 'welcome email: no "business OS"');

  // ── cleanup ──────────────────────────────────────────────────────────
  await sql.query('DELETE FROM workspaces WHERE id = ANY($1)', [cleanupWorkspaces]);
  await sql.query('DELETE FROM users WHERE id = ANY($1)', [cleanupUsers]);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
