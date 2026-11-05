// A payment started by a client who is merged into another client before the
// provider's webhook arrives still lands, on the kept client, exactly once.
//
//   [1] resolveMergedClientId: a live client is itself; a merged-away client
//       resolves to the kept one, through chained merges; an unknown id comes
//       back unchanged; another business's merge record is never followed.
//   [2] Package: the public checkout puts client B in the metadata, B is
//       merged into A, the paid webhook (delivered twice, plus a replay)
//       gives A one package and B nothing.
//   [3] Program purchase, membership subscription (Stripe and PayPal),
//       program subscription and the portal save-card setup all land on A.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/client-merge-payments.test.mjs
import crypto from 'node:crypto';
process.env.STRIPE_SECRET_KEY = 'sk_test_mergepay';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_mergepay';
process.env.SECRETS_KEY ||= 'a'.repeat(64);
process.env.APP_URL ||= 'https://www.joinivy.ai';

const { ensureSchemaApplied } = await import('../api/_lib/ensureSchema.js');
const { sql } = await import('../api/_lib/db.js');
const { mergeClients } = await import('../api/_lib/clientMerge.js');
const { resolveMergedClientId } = await import('../api/_lib/clientResolve.js');
const { applySubscriptionState } = await import('../api/_lib/memberships.js');
const { applyProgramSubscription } = await import('../api/_lib/programs.js');
const { applyPaypalSubscriptionEvent } = await import('../api/_lib/paypalApply.js');
const { default: packageCheckoutHandler } = await import('../api/packages/checkout.js');
const { default: platformWebhook } = await import('../api/webhooks/stripe-platform.js');

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
const STAMP = `${Date.now()}${Math.floor(Math.random() * 1000)}`;

const stripeCalls = [];
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (/api\.stripe\.com/.test(u)) {
    const body = Object.fromEntries(new URLSearchParams(String(init.body || '')));
    stripeCalls.push({ url: u, body });
    if (/\/checkout\/sessions$/.test(u)) return json({ id: `cs_${stripeCalls.length}`, url: `https://checkout.example/cs_${stripeCalls.length}` });
    if (/\/customers\?/.test(u)) return json({ data: [] });
    if (/\/customers$/.test(u)) return json({ id: `cus_${stripeCalls.length}` });
    if (/\/setup_intents\//.test(u)) return json({ id: 'seti_m', status: 'succeeded', payment_method: 'pm_merge_saved' });
    if (/\/payment_methods\//.test(u)) return json({ id: 'pm_merge_saved', card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 } });
    return json({});
  }
  return json({ id: 'em_1' });
};

function mkRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(o) { this.body = o; return this; },
    end(s) { this.body = s ?? this.body; return this; },
  };
}
const HOST = 'www.joinivy.ai';
let ipN = 1;
const req = ({ method = 'POST', body = {} } = {}) => ({
  method, url: '/t', query: {}, body,
  headers: { 'content-type': 'application/json', origin: `https://${HOST}`, host: HOST, 'x-forwarded-for': `198.18.9.${(ipN++ % 200) + 1}` },
});
function signed(payload, secret) {
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', secret).update(`${ts}.${payload}`).digest('hex');
  return { 'stripe-signature': `t=${ts},v1=${sig}`, 'content-type': 'application/json' };
}
let evtN = 0;
async function fire(type, object, acct, eventId = null) {
  const payload = JSON.stringify({ id: eventId || `evt_mp_${STAMP}_${++evtN}`, type, account: acct, data: { object } });
  const res = mkRes();
  await platformWebhook({ method: 'POST', url: '/api/webhooks/stripe-platform', body: payload, headers: signed(payload, process.env.STRIPE_WEBHOOK_SECRET) }, res);
  return res;
}

async function mkBiz(label) {
  const u = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, terms_version, terms_accepted_at)
    VALUES (${`mp-${label}-${STAMP}@example.com`}, 'x', ${label}, NOW(), '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  const wid = (await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end)
    VALUES (${u}, ${`${label} Studio`}, 'active', NOW() + INTERVAL '30 days') RETURNING id`).rows[0].id;
  const slug = `mp-${label}-${STAMP}`.toLowerCase();
  await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug) VALUES (${wid}, ${`${label} Studio`}, ${slug})
    ON CONFLICT (workspace_id) DO UPDATE SET slug = ${slug}`;
  const acct = `acct_mp_${label}_${STAMP}`;
  await sql`INSERT INTO finance_settings (workspace_id, stripe_connect_user_id, stripe_onboarding_status) VALUES (${wid}, ${acct}, 'complete')`;
  return { u, wid, slug, acct };
}
const mkClient = async (wid, name, email) => (await sql`
  INSERT INTO clients (workspace_id, name, email, stage) VALUES (${wid}, ${name}, ${email}, 'active') RETURNING id`).rows[0].id;
const count = async (q) => (await q).rows[0].n;

await ensureSchemaApplied();
const W = await mkBiz('w');
const Z = await mkBiz('z');
try {
  // ── [1] resolver ─────────────────────────────────────────────────────
  console.log('[1] resolveMergedClientId');
  const r1 = await mkClient(W.wid, 'Ana One', `ana1-${STAMP}@example.com`);
  const r2 = await mkClient(W.wid, 'Ana One', `ana2-${STAMP}@example.com`);
  const r3 = await mkClient(W.wid, 'Ana One', `ana3-${STAMP}@example.com`);
  assert((await resolveMergedClientId(W.wid, r1)) === r1, 'a live client resolves to itself');
  await mergeClients({ workspaceId: W.wid, keepId: r2, removeId: r3 });
  await mergeClients({ workspaceId: W.wid, keepId: r1, removeId: r2 });
  assert((await resolveMergedClientId(W.wid, r3)) === r1, 'chained merges (3 into 2, then 2 into 1) resolve to 1');
  assert((await resolveMergedClientId(W.wid, r2.toUpperCase())) === r1, 'case does not matter');
  const ghost = crypto.randomUUID();
  assert((await resolveMergedClientId(W.wid, ghost)) === ghost, 'an unknown id comes back unchanged');
  assert((await resolveMergedClientId(Z.wid, r3)) === r3, "another business never follows this business's merge record");
  assert((await resolveMergedClientId(W.wid, null)) === null && (await resolveMergedClientId(W.wid, 'not-a-uuid')) === 'not-a-uuid', 'empty and malformed ids are left alone');

  // ── [2] package checkout started by B, B merged into A, webhook ──────
  console.log('[2] package bought by a client merged away mid-checkout');
  const A = await mkClient(W.wid, 'Jane Doe', `jane-${STAMP}@example.com`);
  const Bemail = `jane.d-${STAMP}@example.com`;
  const B = await mkClient(W.wid, 'Jane D.', Bemail);
  const pkg = (await sql`INSERT INTO packages (workspace_id, name, session_count, price, visibility, active)
    VALUES (${W.wid}, '5 classes', 5, 100, 'public', TRUE) RETURNING id`).rows[0].id;
  let r = { statusCode: 0 };
  const res = mkRes();
  await packageCheckoutHandler(req({ body: { slug: W.slug, packageId: pkg, name: 'Jane D.', email: Bemail } }), res);
  r = res;
  const cs = stripeCalls.find((c) => /checkout\/sessions$/.test(c.url) && c.body['metadata[package_id]'] === pkg);
  assert(r.statusCode === 200 && cs?.body['metadata[client_id]'] === B, `checkout started for client B (${r.statusCode} ${JSON.stringify(r.body)})`);
  const merged = await mergeClients({ workspaceId: W.wid, keepId: A, removeId: B });
  assert(merged.merged && (await count(sql`SELECT COUNT(*)::int AS n FROM clients WHERE id = ${B}`)) === 0, 'B is merged into A before the payment lands');
  const session = {
    id: `cs_mp_pkg_${STAMP}`, mode: 'payment', payment_status: 'paid', status: 'complete', payment_intent: `pi_mp_pkg_${STAMP}`, amount_total: 10000,
    metadata: { purpose: cs.body['metadata[purpose]'], workspace_id: cs.body['metadata[workspace_id]'], package_id: cs.body['metadata[package_id]'], client_id: cs.body['metadata[client_id]'] },
  };
  r = await fire('checkout.session.completed', session, W.acct, `evt_mp_pkg_${STAMP}`);
  assert(r.statusCode === 200 && r.body.applied === 'package-provisioned', `the webhook provisions the package (${JSON.stringify(r.body)})`);
  r = await fire('checkout.session.completed', session, W.acct, `evt_mp_pkg_${STAMP}`);
  const r2nd = await fire('checkout.session.completed', session, W.acct);
  assert(r.statusCode === 200 && r2nd.statusCode === 200, 'a replay and a second delivery answer 200 (no endless retries)');
  assert((await count(sql`SELECT COUNT(*)::int AS n FROM client_packages WHERE client_id = ${A} AND stripe_session_id = ${session.id}`)) === 1,
    'the package is on A exactly once');
  assert((await count(sql`SELECT COUNT(*)::int AS n FROM client_packages WHERE workspace_id = ${W.wid} AND stripe_session_id = ${session.id}`)) === 1, 'and nowhere else');

  // ── [3] other purchases ─────────────────────────────────────────────
  console.log('[3] programs, memberships, saved card');
  const C = await mkClient(W.wid, 'Cam Keep', `cam-${STAMP}@example.com`);
  const D = await mkClient(W.wid, 'Cam K.', `camk-${STAMP}@example.com`);
  const prog = (await sql`INSERT INTO programs (workspace_id, title, price_cents, billing) VALUES (${W.wid}, 'Strong', 5000, 'one_time') RETURNING id`).rows[0].id;
  const tier = (await sql`INSERT INTO memberships (workspace_id, name, price_cents) VALUES (${W.wid}, 'Monthly', 9000) RETURNING id`).rows[0].id;
  await mergeClients({ workspaceId: W.wid, keepId: C, removeId: D });

  const progSession = {
    id: `cs_mp_prog_${STAMP}`, mode: 'payment', payment_status: 'paid', status: 'complete', payment_intent: `pi_mp_prog_${STAMP}`, amount_total: 5000,
    metadata: { purpose: 'program', workspace_id: W.wid, program_id: prog, client_id: D },
  };
  r = await fire('checkout.session.completed', progSession, W.acct);
  await fire('checkout.session.completed', progSession, W.acct);
  assert(r.body.applied === 'program-purchase', `program purchase lands (${JSON.stringify(r.body)})`);
  assert((await count(sql`SELECT COUNT(*)::int AS n FROM program_enrollments WHERE client_id = ${C} AND stripe_session_id = ${progSession.id}`)) === 1, 'the enrollment is on the kept client, once');

  const sub = { id: `sub_mp_${STAMP}`, status: 'active', customer: 'cus_mp', current_period_end: Math.floor(Date.now() / 1000) + 86400 * 30,
    metadata: { purpose: 'membership', workspace_id: W.wid, membership_id: tier, client_id: D }, items: { data: [] } };
  await applySubscriptionState({ workspaceId: W.wid, sub });
  await applySubscriptionState({ workspaceId: W.wid, sub });
  assert((await count(sql`SELECT COUNT(*)::int AS n FROM client_memberships WHERE client_id = ${C} AND stripe_subscription_id = ${sub.id}`)) === 1, 'a Stripe membership lands on the kept client, once');

  const pp = await applyPaypalSubscriptionEvent({ parsed: {
    subscriptionId: `I-MP${STAMP}`, subStatus: 'active', metadata: { workspace_id: W.wid, membership_id: tier, client_id: D },
  } });
  assert(pp === 'created' && (await count(sql`SELECT COUNT(*)::int AS n FROM client_memberships WHERE client_id = ${C} AND paypal_subscription_id = ${`I-MP${STAMP}`}`)) === 1,
    `a PayPal membership lands on the kept client (${pp})`);

  const progSub = { id: `sub_mp_prog_${STAMP}`, status: 'active', current_period_end: Math.floor(Date.now() / 1000) + 86400 * 30,
    metadata: { purpose: 'program', workspace_id: W.wid, program_id: prog, client_id: D } };
  const ps = await applyProgramSubscription({ workspaceId: W.wid, sub: progSub });
  assert(ps !== 'missing' && ps !== 'ignored', `a program subscription finds the kept client (${ps})`);

  r = await fire('checkout.session.completed', {
    id: `cs_mp_setup_${STAMP}`, mode: 'setup', status: 'complete', setup_intent: 'seti_m', customer: 'cus_mp',
    metadata: { purpose: 'save_card', workspace_id: W.wid, client_id: D },
  }, W.acct);
  const card = (await sql`SELECT payment_method_id, payment_method_last4 FROM clients WHERE id = ${C}`).rows[0];
  assert(r.body.marked === 'card-saved' && card.payment_method_id === 'pm_merge_saved' && card.payment_method_last4 === '4242', 'a card saved by the merged-away record is kept on the kept client');

  // Isolation: Z's webhook naming W's merged-away client never touches W.
  const zPkg = (await sql`INSERT INTO packages (workspace_id, name, session_count, price, visibility, active)
    VALUES (${Z.wid}, 'Z pack', 2, 10, 'public', TRUE) RETURNING id`).rows[0].id;
  r = await fire('checkout.session.completed', {
    id: `cs_mp_z_${STAMP}`, mode: 'payment', payment_status: 'paid', status: 'complete', payment_intent: `pi_mp_z_${STAMP}`, amount_total: 1000,
    metadata: { purpose: 'package', workspace_id: Z.wid, package_id: zPkg, client_id: B },
  }, Z.acct);
  assert(r.statusCode === 200 && r.body.ignored === 'package client not found'
    && (await count(sql`SELECT COUNT(*)::int AS n FROM client_packages WHERE stripe_session_id = ${`cs_mp_z_${STAMP}`}`)) === 0
    && (await count(sql`SELECT COUNT(*)::int AS n FROM client_packages WHERE client_id = ${A}`)) === 1,
  `another business's webhook is not routed to this business's client (${r.statusCode} ${JSON.stringify(r.body)})`);
} catch (e) {
  fail++;
  console.log('  ✗ threw:', e.stack || e.message);
} finally {
  await sql`DELETE FROM users WHERE id = ANY(${[W.u, Z.u]}::uuid[])`;
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
