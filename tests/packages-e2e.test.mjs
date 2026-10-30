// Packages (bundles of session credits), end to end, for the owner and
// for the client.
//
//   [1] owner creates / edits / archives a template; validation; another
//       owner cannot touch it; only active public templates reach the
//       public booking page
//   [2] public purchase mints a checkout session with the right amount,
//       metadata and connected account; archived / private / unpriced
//       templates and businesses without card payments are refused
//   [3] paid webhook provisions client_packages once (credits_remaining =
//       session_count, expiry, payment intent); duplicate delivery is a
//       no-op; unpaid session provisions nothing
//   [4] the client portal lists the right remaining count, scoped to the
//       client's own businesses
//   [5] client books with credits: credits tick down, booking carries the
//       package link, uncovered service / too many slots refused, the last
//       credit flips the package to exhausted and tells the owner, zero
//       is the floor
//   [6] client cancellation restores the credit exactly once
//   [7] owner books against the client's package and owner cancel restores
//   [8] expired credits are hidden, refused, and never consumed
//   [9] workspace isolation: another owner cannot read or edit this
//       client's packages
//  [10] owner-side sale from a template and as a custom bundle
//  [11] charge.refunded: a full refund cancels the bundle, a partial refund
//       leaves it to the owner, re-delivery is a no-op; the legacy
//       per-workspace webhook does the same
//  [12] archived business: credits cannot be spent there
//
// Run with: node --import ./tests/bootstrap.mjs ./tests/packages-e2e.test.mjs
import crypto from 'node:crypto';
process.env.STRIPE_SECRET_KEY = 'sk_test_pkg';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_pkg';
process.env.SECRETS_KEY ||= 'a'.repeat(64);
process.env.APP_URL ||= 'https://www.joinivy.ai';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import { encrypt } from '../api/_lib/secrets.js';
import { consumeCredit } from '../api/_lib/packages.js';
import packagesHandler from '../api/packages/index.js';
import packageHandler from '../api/packages/[id].js';
import packageCheckoutHandler from '../api/packages/checkout.js';
import publicCalendarHandler from '../api/calendar/public/[slug].js';
import mePackagesHandler from '../api/me/packages.js';
import meBookHandler from '../api/me/packages/[id]/book.js';
import meBookingHandler from '../api/me/bookings/[id].js';
import ownerBookingsHandler from '../api/calendar/bookings.js';
import ownerBookingHandler from '../api/calendar/bookings/[id].js';
import clientPackagesHandler from '../api/clients/[id]/packages.js';
import clientPackageHandler from '../api/clients/[id]/packages/[cpId].js';
import platformWebhook from '../api/webhooks/stripe-platform.js';
import legacyWebhook from '../api/webhooks/stripe/[workspaceId].js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

// ── Outbound network is mocked: Stripe + the mail provider ───────────
const stripeCalls = [];
const emails = [];
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (/api\.stripe\.com/.test(u)) {
    const body = Object.fromEntries(new URLSearchParams(String(init.body || '')));
    stripeCalls.push({ url: u, method: init.method || 'GET', headers: init.headers || {}, body });
    if (/\/checkout\/sessions$/.test(u)) return json({ id: `cs_${stripeCalls.length}`, url: `https://checkout.example/cs_${stripeCalls.length}` });
    if (/\/customers\?/.test(u)) return json({ data: [] });
    if (/\/customers$/.test(u)) return json({ id: `cus_${stripeCalls.length}` });
    return json({});
  }
  if (/api\.resend\.com/.test(u)) {
    try { emails.push(JSON.parse(String(init.body))); } catch { emails.push({}); }
    return json({ id: `em_${emails.length}` });
  }
  return json({});
};
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

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
const req = ({ method = 'GET', cookie, query = {}, body = {}, ip = '198.18.8.1' } = {}) => ({
  method, url: '/t', query, body,
  headers: { 'content-type': 'application/json', origin: `https://${HOST}`, host: HOST, 'x-forwarded-for': ip,
    ...(cookie ? { cookie } : {}) },
});
async function call(handler, r) { const res = mkRes(); await handler(r, res); return res; }

let evtN = 0;
function signed(payload, secret) {
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', secret).update(`${ts}.${payload}`).digest('hex');
  return { 'stripe-signature': `t=${ts},v1=${sig}`, 'content-type': 'application/json' };
}
async function fire(type, object, acct, eventId = null) {
  const payload = JSON.stringify({ id: eventId || `evt_pkg_${Date.now()}_${++evtN}`, type, account: acct, data: { object } });
  const res = mkRes();
  await platformWebhook({ method: 'POST', url: '/api/webhooks/stripe-platform', body: payload, headers: signed(payload, process.env.STRIPE_WEBHOOK_SECRET) }, res);
  return res;
}
const paidPkgSession = ({ id, pi, wid, pkgId, clientId, amount, paid = true }) => ({
  id, mode: 'payment', payment_status: paid ? 'paid' : 'unpaid', status: 'complete', payment_intent: pi, amount_total: amount,
  metadata: { purpose: 'package', workspace_id: wid, package_id: pkgId, client_id: clientId },
});

const STAMP = Date.now();
// What a person reads: HTML comments are not rendered.
const visible = (s) => String(s || '').replace(/<!--[\s\S]*?-->/g, '');
const noVendor = (s) => !/stripe|square|paypal|business os/i.test(visible(s));
const noDash = (s) => !/[–—]/.test(visible(s));

async function mkBiz(label, { connected = true } = {}) {
  const u = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, terms_version, terms_accepted_at)
    VALUES (${`pk-${label}-${STAMP}@example.com`}, 'x', ${label}, NOW(), '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  const wid = (await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end)
    VALUES (${u}, ${`${label} Studio`}, 'active', NOW() + INTERVAL '30 days') RETURNING id`).rows[0].id;
  const slug = `pk-${label}-${STAMP}`.toLowerCase();
  await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug) VALUES (${wid}, ${`${label} Studio`}, ${slug})
    ON CONFLICT (workspace_id) DO UPDATE SET slug = ${slug}, biz_name = ${`${label} Studio`}`;
  const acct = `acct_pk_${label}_${STAMP}`;
  if (connected) {
    await sql`INSERT INTO finance_settings (workspace_id, stripe_connect_user_id, stripe_onboarding_status)
      VALUES (${wid}, ${acct}, 'complete')`;
  }
  const svc1 = (await sql`INSERT INTO services (workspace_id, name, price, duration_minutes, visibility)
    VALUES (${wid}, 'Cut', 50, 60, 'public') RETURNING id`).rows[0].id;
  const svc2 = (await sql`INSERT INTO services (workspace_id, name, price, duration_minutes, visibility)
    VALUES (${wid}, 'Color', 80, 60, 'public') RETURNING id`).rows[0].id;
  return { userId: u, wid, slug, acct, svc1, svc2, cookie: `ivy_session=${signSession(u)}` };
}
// A portal user who is a client of `biz`.
async function mkClient(label, biz) {
  const email = `pk-client-${label}-${STAMP}@example.com`;
  const u = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, terms_version, terms_accepted_at)
    VALUES (${email}, 'x', 'Casey', NOW(), '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  const c = (await sql`INSERT INTO clients (workspace_id, name, email, stage, user_id)
    VALUES (${biz.wid}, 'Casey Client', ${email}, 'active', ${u}) RETURNING id`).rows[0].id;
  return { userId: u, clientId: c, email, cookie: `ivy_session=${signSession(u)}` };
}
function nextBookableDate(offsetWeeks = 0) {
  const d = new Date(Date.now() + (7 + offsetWeeks * 7) * 864e5);
  while (d.getUTCDay() !== 2) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
const cpRow = (id) => sql`SELECT * FROM client_packages WHERE id = ${id}`.then((r) => r.rows[0]);

async function run() {
  await ensureSchemaApplied();
  const A = await mkBiz('A');
  const B = await mkBiz('B');
  const C = await mkBiz('C', { connected: false });
  const casey = await mkClient('casey', A);
  const bClient = await mkClient('bob', B);
  const date = nextBookableDate();
  const date2 = nextBookableDate(1);

  console.log('\n[1] owner creates / edits / archives templates');
  let r = await call(packagesHandler, req({ method: 'POST', cookie: A.cookie, body: { name: '5 Cuts', sessionCount: 5, price: 200, expiryDays: 90, serviceIds: [A.svc1] } }));
  assert(r.statusCode === 201 && r.body.package.sessionCount === 5 && r.body.package.price === 200 && r.body.package.expiryDays === 90, `template created (${r.statusCode})`);
  const pkg = r.body.package;
  assert(pkg.active === true && pkg.visibility === 'public' && pkg.serviceIds.length === 1, 'defaults: active, public, scoped to one service');
  r = await call(packagesHandler, req({ method: 'POST', cookie: A.cookie, body: { name: 'Zero', sessionCount: 0, price: 10 } }));
  assert(r.statusCode === 400 && noDash(r.body.error) && noVendor(r.body.error), `sessionCount 0 refused with plain copy (${r.body.error})`);
  r = await call(packagesHandler, req({ method: 'POST', cookie: A.cookie, body: { name: 'Bad', sessionCount: 3, price: 10, expiryDays: 0 } }));
  assert(r.statusCode === 400 && noDash(r.body.error), `expiryDays 0 refused with plain copy (${r.body.error})`);
  r = await call(packagesHandler, req({ method: 'POST', cookie: A.cookie, body: { name: 'Cross', sessionCount: 3, price: 10, serviceIds: [B.svc1] } }));
  assert(r.statusCode === 400, "another workspace's service id is refused");
  r = await call(packageHandler, req({ method: 'PATCH', cookie: A.cookie, query: { id: pkg.id }, body: { price: 180, description: 'Five cuts, use within 90 days' } }));
  assert(r.statusCode === 200 && r.body.package.price === 180, 'owner edits price');
  r = await call(packageHandler, req({ method: 'PATCH', cookie: B.cookie, query: { id: pkg.id }, body: { price: 1 } }));
  assert(r.statusCode === 404 && (await sql`SELECT price FROM packages WHERE id = ${pkg.id}`).rows[0].price == 180, "owner B cannot edit A's template");
  // A private one (owner-sold only) and an archived one must stay off the public page.
  const priv = (await call(packagesHandler, req({ method: 'POST', cookie: A.cookie, body: { name: 'VIP 10', sessionCount: 10, price: 500, visibility: 'private' } }))).body.package;
  const old = (await call(packagesHandler, req({ method: 'POST', cookie: A.cookie, body: { name: 'Old Deal', sessionCount: 3, price: 90 } }))).body.package;
  r = await call(packageHandler, req({ method: 'DELETE', cookie: A.cookie, query: { id: old.id } }));
  assert(r.statusCode === 204 && (await sql`SELECT active FROM packages WHERE id = ${old.id}`).rows[0].active === false, 'archive (soft delete) flips active off');
  r = await call(packagesHandler, req({ cookie: A.cookie }));
  assert(r.statusCode === 200 && r.body.packages.length === 3 && r.body.packages[0].active === true, 'owner list shows all three, active first');
  r = await call(packagesHandler, req({ cookie: B.cookie }));
  assert(r.statusCode === 200 && r.body.packages.length === 0, "owner B's list has none of A's templates");
  r = await call(publicCalendarHandler, req({ query: { slug: A.slug } }));
  const pubPkgs = r.body?.calendar?.packages || [];
  assert(pubPkgs.length === 1 && pubPkgs[0].id === pkg.id && pubPkgs[0].sessionCount === 5 && pubPkgs[0].price === 180, 'public page lists only the active public template');
  assert(r.body?.calendar?.giftCardsAvailable === true, 'public page says gift cards can be bought (card payments connected)');
  r = await call(publicCalendarHandler, req({ query: { slug: C.slug } }));
  assert(r.body?.calendar?.giftCardsAvailable === false, 'public page hides gift cards when card payments are not connected');

  console.log('\n[2] public purchase mints a checkout session');
  const buyer = { name: 'Casey Client', email: casey.email };
  const buy = (over = {}, ip = '198.18.8.2') => call(packageCheckoutHandler, req({ method: 'POST', ip, body: { slug: A.slug, packageId: pkg.id, ...buyer, ...over } }));
  r = await buy();
  assert(r.statusCode === 200 && /^https:\/\/checkout\.example\//.test(r.body.url), `checkout → 200 with redirect url (${r.statusCode} ${JSON.stringify(r.body)})`);
  const cs = stripeCalls.find((c) => /checkout\/sessions$/.test(c.url));
  assert(cs?.headers['Stripe-Account'] === A.acct, 'session is created on the connected account');
  assert(cs?.body['line_items[0][price_data][unit_amount]'] === '18000' && cs?.body.mode === 'payment', 'amount is the current price, $180.00');
  assert(cs?.body['metadata[purpose]'] === 'package' && cs?.body['metadata[package_id]'] === pkg.id && cs?.body['metadata[workspace_id]'] === A.wid && cs?.body['metadata[client_id]'] === casey.clientId, 'metadata: purpose / package / workspace / existing client matched by email');
  assert(cs?.body['payment_intent_data[metadata][purpose]'] === 'package' && cs?.body['payment_intent_data[metadata][client_id]'] === casey.clientId, 'payment intent metadata mirrors it');
  assert(!!cs?.body.customer, 'buyer gets a customer on the connected account');
  r = await buy({ packageId: old.id });
  assert(r.statusCode === 400, 'archived template cannot be bought');
  r = await buy({ packageId: priv.id });
  assert(r.statusCode === 400, 'private template cannot be self-bought');
  r = await buy({ slug: B.slug });
  assert(r.statusCode === 404, "A's template is unknown at B's booking page");
  r = await buy({ email: 'nope' });
  assert(r.statusCode === 400, 'invalid email refused');
  const cPkg = (await call(packagesHandler, req({ method: 'POST', cookie: C.cookie, body: { name: 'C Pack', sessionCount: 2, price: 50 } }))).body.package;
  r = await buy({ slug: C.slug, packageId: cPkg.id, email: `new-${STAMP}@example.com` });
  assert(r.statusCode === 400 && noVendor(r.body.error) && noDash(r.body.error), `business without card payments → plain copy (${r.body.error})`);
  // A brand-new buyer becomes a lead in the CRM before checkout.
  r = await buy({ email: `newbie-${STAMP}@example.com`, name: 'New Buyer' }, '198.18.8.3');
  const newbie = (await sql`SELECT id, stage, source FROM clients WHERE workspace_id = ${A.wid} AND email = ${`newbie-${STAMP}@example.com`}`).rows[0];
  assert(r.statusCode === 200 && newbie?.stage === 'lead' && newbie?.source === 'package', 'unknown buyer is created as a lead (source package)');

  console.log('\n[3] paid webhook provisions the bundle once');
  const pi1 = `pi_pk_1_${STAMP}`;
  r = await fire('checkout.session.completed', paidPkgSession({ id: 'cs_pk_unpaid', pi: 'pi_pk_unpaid', wid: A.wid, pkgId: pkg.id, clientId: casey.clientId, amount: 18000, paid: false }), A.acct);
  assert(/awaiting settlement/.test(r.body.ignored || ''), 'unpaid session provisions nothing');
  assert((await sql`SELECT COUNT(*)::int AS n FROM client_packages WHERE workspace_id = ${A.wid}`).rows[0].n === 0, 'no client package yet');
  const sess = paidPkgSession({ id: `cs_pk_1_${STAMP}`, pi: pi1, wid: A.wid, pkgId: pkg.id, clientId: casey.clientId, amount: 18000 });
  r = await fire('checkout.session.completed', sess, A.acct, `evt_pk_paid_${STAMP}`);
  assert(r.statusCode === 200 && r.body.applied === 'package-provisioned', `paid session provisions (${JSON.stringify(r.body)})`);
  let cps = (await sql`SELECT * FROM client_packages WHERE workspace_id = ${A.wid}`).rows;
  assert(cps.length === 1, 'exactly one client package');
  const cp = cps[0];
  assert(Number(cp.credits_total) === 5 && Number(cp.credits_remaining) === 5 && cp.status === 'active', 'credits_remaining = session_count = 5');
  assert(cp.client_id === casey.clientId && cp.package_id === pkg.id && cp.name === '5 Cuts' && Number(cp.price) === 180, 'linked to the client + template, price as charged');
  assert(cp.stripe_session_id === sess.id && cp.stripe_payment_intent === pi1, 'session id (idempotency) and payment intent (refunds) stored');
  const daysOut = (new Date(cp.expires_at).getTime() - Date.now()) / 864e5;
  assert(daysOut > 89 && daysOut < 91, `expires in ~90 days (${daysOut.toFixed(1)})`);
  r = await fire('checkout.session.completed', sess, A.acct, `evt_pk_paid_${STAMP}`);
  assert(r.body.deduped === true, 'same event id deduped');
  r = await fire('checkout.session.completed', sess, A.acct);
  assert(r.body.ignored === 'package already provisioned', 'replay with a new event id is a no-op');
  r = await fire('checkout.session.async_payment_succeeded', sess, A.acct);
  assert(r.body.ignored === 'package already provisioned', 'async settle after a paid completion is a no-op');
  assert((await sql`SELECT COUNT(*)::int AS n FROM client_packages WHERE workspace_id = ${A.wid}`).rows[0].n === 1, 'still one client package');
  r = await fire('checkout.session.completed', { ...sess, id: 'cs_pk_wrongws', metadata: { ...sess.metadata, workspace_id: B.wid } }, A.acct);
  assert(r.statusCode === 400, 'metadata workspace that does not match the connected account is rejected');

  console.log('\n[4] client portal lists the right remaining count');
  r = await call(mePackagesHandler, req({ cookie: casey.cookie }));
  assert(r.statusCode === 200 && r.body.packages.length === 1, 'Casey sees one package');
  const mine = r.body.packages[0];
  assert(mine.creditsRemaining === 5 && mine.creditsTotal === 5 && mine.businessName === 'A Studio' && mine.bookingSlug === A.slug && mine.archived === false, `5 of 5 at A Studio with the booking handle (${JSON.stringify(mine).slice(0, 160)})`);
  assert(mine.clientId === undefined && !('workspaceId' in mine), 'portal payload carries no internal ids beyond the package');
  r = await call(mePackagesHandler, req({ cookie: bClient.cookie }));
  assert(r.statusCode === 200 && r.body.packages.length === 0, "B's client sees nothing of A's");
  r = await call(mePackagesHandler, req({}));
  assert(r.statusCode === 401, 'anonymous → 401');

  console.log('\n[5] client books with credits');
  const bookWith = (body, cookie = casey.cookie) => call(meBookHandler, req({ method: 'POST', cookie, query: { id: cp.id }, body }));
  r = await bookWith({ serviceId: A.svc2, slots: [{ date, startMin: 600, endMin: 660 }] });
  assert(r.statusCode === 400 && /cover/.test(r.body.error), 'a service outside the package is refused');
  r = await bookWith({ serviceId: A.svc1, slots: [{ date, startMin: 600, endMin: 660 }] });
  assert(r.statusCode === 200 && r.body.creditsRemaining === 4 && r.body.bookings.length === 1, `one slot → 4 left (${r.statusCode} ${JSON.stringify(r.body).slice(0, 120)})`);
  const b1 = r.body.bookings[0];
  assert(b1.clientPackageId === cp.id, 'the booking records which package paid for it');
  const b1row = (await sql`SELECT client_package_id, client_id, workspace_id, source FROM bookings WHERE id = ${b1.id}`).rows[0];
  assert(b1row.client_package_id === cp.id && b1row.client_id === casey.clientId && b1row.workspace_id === A.wid && b1row.source === 'client', 'booking row linked to package, client and workspace');
  r = await bookWith({ serviceId: A.svc1, slots: [600, 720, 840, 960, 1020].map((m) => ({ date: date2, startMin: m, endMin: m + 60 })) });
  assert(r.statusCode === 400 && /only have 4/.test(r.body.error) && Number((await cpRow(cp.id)).credits_remaining) === 4, 'five slots with four credits is refused, nothing consumed');
  r = await bookWith({ serviceId: A.svc1, slots: [{ date, startMin: 600, endMin: 660 }] });
  assert(r.statusCode === 400 && /taken/.test(r.body.error) && Number((await cpRow(cp.id)).credits_remaining) === 4, 'a taken slot is refused, nothing consumed');
  r = await bookWith({ serviceId: A.svc1, slots: [{ date, startMin: 600, endMin: 660 }] }, bClient.cookie);
  assert(r.statusCode === 404, "B's client cannot spend Casey's credits");
  emails.length = 0;
  r = await bookWith({ serviceId: A.svc1, slots: [600, 720, 840, 960].map((m) => ({ date: date2, startMin: m, endMin: m + 60 })) });
  assert(r.statusCode === 200 && r.body.creditsRemaining === 0 && r.body.status === 'exhausted', 'last four credits → 0 left, exhausted');
  await settle(600);
  const ownerMail = emails.find((e) => /out of sessions/i.test(e.subject || ''));
  assert(!!ownerMail, 'owner is told the client ran out of sessions (renewal moment)');
  assert(noVendor(ownerMail?.html) && !/—/.test(ownerMail?.html || ''), 'owner email names no vendor, no em dash');
  r = await bookWith({ serviceId: A.svc1, slots: [{ date: nextBookableDate(2), startMin: 600, endMin: 660 }] });
  assert(r.statusCode === 400 && Number((await cpRow(cp.id)).credits_remaining) === 0, 'no credits left: refused, still 0');
  const dead = await consumeCredit({ workspaceId: A.wid, clientPackageId: cp.id, clientId: casey.clientId, serviceId: A.svc1 });
  assert(dead.ok === false && Number((await cpRow(cp.id)).credits_remaining) === 0, 'consumeCredit cannot take the count below zero');

  console.log('\n[6] client cancellation restores the credit exactly once');
  r = await call(meBookingHandler, req({ method: 'DELETE', cookie: casey.cookie, query: { id: b1.id } }));
  assert(r.statusCode === 200 && r.body.cancelled === true, 'Casey cancels the first booking');
  await settle();
  let c = await cpRow(cp.id);
  assert(Number(c.credits_remaining) === 1 && c.status === 'active', 'credit restored: 1 left, active again');
  r = await call(meBookingHandler, req({ method: 'DELETE', cookie: casey.cookie, query: { id: b1.id } }));
  assert(r.statusCode === 400 && Number((await cpRow(cp.id)).credits_remaining) === 1, 'cancelling again does not restore twice');
  r = await call(meBookingHandler, req({ method: 'DELETE', cookie: bClient.cookie, query: { id: b1.id } }));
  assert(r.statusCode === 404, "B's client cannot touch Casey's booking");

  console.log('\n[7] owner books against the client package and owner cancel restores');
  const ownerBook = (body, cookie = A.cookie) => call(ownerBookingsHandler, req({ method: 'POST', cookie, body: {
    serviceId: A.svc1, clientId: casey.clientId, clientName: 'Casey Client', clientEmail: casey.email,
    date: nextBookableDate(2), startMin: 600, endMin: 660, clientPackageId: cp.id, skipConflictCheck: true, ...body } }));
  r = await ownerBook({ serviceId: A.svc2 });
  assert(r.statusCode === 400 && Number((await cpRow(cp.id)).credits_remaining) === 1, 'owner booking an uncovered service with the package is refused');
  r = await ownerBook({});
  assert(r.statusCode === 201 && r.body.booking.clientPackageId === cp.id, `owner booking consumes the credit (${r.statusCode})`);
  c = await cpRow(cp.id);
  assert(Number(c.credits_remaining) === 0 && c.status === 'exhausted', 'owner booking took the last credit');
  const ob = r.body.booking;
  r = await ownerBook({ startMin: 720, endMin: 780 });
  assert(r.statusCode === 400, 'owner cannot book on an exhausted package');
  r = await call(ownerBookingHandler, req({ method: 'DELETE', cookie: B.cookie, query: { id: ob.id } }));
  assert(r.statusCode === 404, "owner B cannot cancel A's booking");
  r = await call(ownerBookingHandler, req({ method: 'DELETE', cookie: A.cookie, query: { id: ob.id } }));
  assert(r.statusCode === 204, 'owner A cancels');
  await settle();
  c = await cpRow(cp.id);
  assert(Number(c.credits_remaining) === 1 && c.status === 'active', 'owner cancel restores the credit');
  r = await ownerBook({ clientId: bClient.clientId, clientEmail: bClient.email, startMin: 780, endMin: 840 });
  assert(r.statusCode === 400 && Number((await cpRow(cp.id)).credits_remaining) === 1, "another client cannot be booked on Casey's package");

  console.log('\n[8] expired credits are hidden, refused and never consumed');
  await sql`UPDATE client_packages SET expires_at = NOW() - INTERVAL '1 day' WHERE id = ${cp.id}`;
  r = await call(mePackagesHandler, req({ cookie: casey.cookie }));
  assert(r.body.packages.length === 0, 'portal hides the expired package by default');
  r = await call(mePackagesHandler, req({ cookie: casey.cookie, query: { all: '1' } }));
  assert(r.body.packages.length === 1 && r.body.packages[0].daysToExpiry < 0, 'history view shows it with a negative days-to-expiry');
  r = await bookWith({ serviceId: A.svc1, slots: [{ date: nextBookableDate(3), startMin: 600, endMin: 660 }] });
  assert(r.statusCode === 400 && /expired/i.test(r.body.error), 'booking on an expired package is refused');
  r = await ownerBook({ startMin: 900, endMin: 960 });
  assert(r.statusCode === 400, 'owner cannot book on an expired package either');
  const exp = await consumeCredit({ workspaceId: A.wid, clientPackageId: cp.id, clientId: casey.clientId, serviceId: A.svc1 });
  assert(exp.ok === false && Number((await cpRow(cp.id)).credits_remaining) === 1, 'consumeCredit refuses an expired package');
  r = await call(clientPackageHandler, req({ method: 'PATCH', cookie: A.cookie, query: { id: casey.clientId, cpId: cp.id }, body: { extendDays: 30 } }));
  assert(r.statusCode === 200 && r.body.package.daysToExpiry > 0, 'owner extends the expiry');

  console.log('\n[9] workspace isolation on client packages');
  r = await call(clientPackagesHandler, req({ cookie: B.cookie, query: { id: casey.clientId } }));
  assert(r.statusCode === 404, "owner B cannot list A's client's packages");
  r = await call(clientPackageHandler, req({ method: 'PATCH', cookie: B.cookie, query: { id: casey.clientId, cpId: cp.id }, body: { addCredits: 100 } }));
  assert(r.statusCode === 404 && Number((await cpRow(cp.id)).credits_remaining) === 1, "owner B cannot top up A's client package");
  r = await call(clientPackageHandler, req({ method: 'DELETE', cookie: B.cookie, query: { id: casey.clientId, cpId: cp.id } }));
  assert(r.statusCode === 404 && (await cpRow(cp.id)).status === 'active', "owner B cannot cancel A's client package");
  r = await call(clientPackagesHandler, req({ cookie: A.cookie, query: { id: casey.clientId } }));
  assert(r.statusCode === 200 && r.body.packages.length === 1 && r.body.packages[0].creditsRemaining === 1, 'owner A sees the package with 1 credit left');

  console.log('\n[10] owner-side sale');
  r = await call(clientPackagesHandler, req({ method: 'POST', cookie: A.cookie, query: { id: casey.clientId }, body: { packageId: priv.id } }));
  assert(r.statusCode === 201 && r.body.package.creditsRemaining === 10 && r.body.package.name === 'VIP 10', 'owner sells the private template to Casey');
  const vip = r.body.package;
  r = await call(clientPackagesHandler, req({ method: 'POST', cookie: A.cookie, query: { id: casey.clientId }, body: { packageId: old.id } }));
  assert(r.statusCode === 400, 'an archived template cannot be sold');
  r = await call(clientPackagesHandler, req({ method: 'POST', cookie: A.cookie, query: { id: casey.clientId }, body: { name: 'Comp 2', sessionCount: 2, price: 0 } }));
  assert(r.statusCode === 201 && r.body.package.creditsRemaining === 2 && r.body.package.packageId === null, 'custom bundle without a template');
  r = await call(clientPackagesHandler, req({ method: 'POST', cookie: A.cookie, query: { id: casey.clientId }, body: { name: 'Bad', sessionCount: 0, price: 0 } }));
  assert(r.statusCode === 400 && noDash(r.body.error), `owner-side validation copy is plain (${r.body.error})`);
  r = await call(mePackagesHandler, req({ cookie: casey.cookie }));
  assert(r.body.packages.length === 3 && r.body.packages.map((p) => p.creditsRemaining).sort().join(',') === '1,10,2', 'Casey now sees all three active packages');

  console.log('\n[11] charge.refunded from the payment dashboard');
  r = await fire('charge.refunded', { id: 'ch_pk_1', payment_intent: pi1, amount: 18000, amount_refunded: 5000 }, A.acct);
  assert(r.body.applied === 'package-refund-noted' && (await cpRow(cp.id)).status === 'active', 'partial refund: owner is told, bundle untouched');
  r = await fire('charge.refunded', { id: 'ch_pk_1', payment_intent: pi1, amount: 18000, amount_refunded: 18000 }, B.acct);
  assert(r.body.ignored === 'no purchase for payment_intent' && (await cpRow(cp.id)).status === 'active', "an event on B's account cannot cancel A's bundle");
  r = await fire('charge.refunded', { id: 'ch_pk_1', payment_intent: pi1, amount: 18000, amount_refunded: 18000 }, A.acct);
  assert(r.body.applied === 'package-refund-synced' && r.body.fully === true, `full refund synced (${JSON.stringify(r.body)})`);
  c = await cpRow(cp.id);
  assert(c.status === 'cancelled' && Number(c.credits_remaining) === 0, 'full refund cancels the bundle and zeroes the credits');
  r = await fire('charge.refunded', { id: 'ch_pk_1', payment_intent: pi1, amount: 18000, amount_refunded: 18000 }, A.acct);
  assert(r.body.ignored === 'refund already recorded', 're-delivery is a no-op');
  r = await bookWith({ serviceId: A.svc1, slots: [{ date: nextBookableDate(3), startMin: 600, endMin: 660 }] });
  assert(r.statusCode === 400, 'the refunded bundle can no longer book');
  r = await call(mePackagesHandler, req({ cookie: casey.cookie }));
  assert(r.body.packages.length === 2 && !r.body.packages.some((p) => p.id === cp.id), 'portal drops the refunded bundle from the active list');

  // Legacy per-workspace webhook (owner pasted their own keys): same sync.
  const L = await mkBiz('L', { connected: false });
  const lClient = await mkClient('lc', L);
  const lPkg = (await call(packagesHandler, req({ method: 'POST', cookie: L.cookie, body: { name: 'L Pack', sessionCount: 4, price: 100 } }))).body.package;
  const lSecret = `whsec_legacy_${STAMP}`;
  await sql`INSERT INTO finance_settings (workspace_id, stripe_secret_encrypted, stripe_webhook_secret_encrypted)
    VALUES (${L.wid}, ${encrypt('sk_test_legacy')}, ${encrypt(lSecret)})`;
  const legacyFire = async (type, object) => {
    const payload = JSON.stringify({ id: `evt_lg_${Date.now()}_${++evtN}`, type, data: { object } });
    const res = mkRes();
    await legacyWebhook({ method: 'POST', url: '/t', query: { workspaceId: L.wid }, body: payload, headers: signed(payload, lSecret) }, res);
    return res;
  };
  const lpi = `pi_lg_${STAMP}`;
  r = await legacyFire('checkout.session.completed', paidPkgSession({ id: `cs_lg_${STAMP}`, pi: lpi, wid: L.wid, pkgId: lPkg.id, clientId: lClient.clientId, amount: 10000 }));
  assert(r.statusCode === 200 && r.body.applied === 'package-provisioned', `legacy webhook provisions (${JSON.stringify(r.body)})`);
  const lcp = (await sql`SELECT * FROM client_packages WHERE workspace_id = ${L.wid}`).rows[0];
  assert(Number(lcp?.credits_remaining) === 4 && lcp.stripe_payment_intent === lpi, 'legacy: 4 credits, payment intent stored');
  r = await legacyFire('charge.refunded', { id: 'ch_lg', payment_intent: lpi, amount: 10000, amount_refunded: 10000 });
  assert(r.body.applied === 'package-refund-synced' && (await cpRow(lcp.id)).status === 'cancelled', 'legacy webhook: full refund cancels the bundle');

  console.log('\n[12] archived business: credits cannot be spent there');
  await sql`UPDATE workspaces SET subscription_status = 'cancelled', subscription_period_end = NOW() - INTERVAL '2 days' WHERE id = ${A.wid}`;
  r = await call(mePackagesHandler, req({ cookie: casey.cookie }));
  assert(r.statusCode === 200 && r.body.packages.length === 2 && r.body.packages.every((p) => p.archived === true), 'portal still lists the packages, flagged archived');
  r = await call(meBookHandler, req({ method: 'POST', cookie: casey.cookie, query: { id: vip.id }, body: { serviceId: A.svc1, slots: [{ date: nextBookableDate(3), startMin: 600, endMin: 660 }] } }));
  assert(r.statusCode === 403 && r.body.code === 'business_archived' && Number((await cpRow(vip.id)).credits_remaining) === 10, 'booking with credits at an archived business → 403, nothing consumed');
  r = await call(packageCheckoutHandler, req({ method: 'POST', ip: '198.18.8.4', body: { slug: A.slug, packageId: pkg.id, ...buyer } }));
  assert(r.statusCode === 403 && r.body.code === 'business_archived', 'buying a package from an archived business → 403');
  await sql`UPDATE workspaces SET subscription_status = 'active', subscription_period_end = NOW() + INTERVAL '30 days' WHERE id = ${A.wid}`;

  // Cleanup
  for (const w of [A, B, C, L]) {
    await sql`DELETE FROM bookings WHERE workspace_id = ${w.wid}`;
    await sql`DELETE FROM client_packages WHERE workspace_id = ${w.wid}`;
    await sql`DELETE FROM packages WHERE workspace_id = ${w.wid}`;
    await sql`DELETE FROM workspaces WHERE id = ${w.wid}`;
    await sql`DELETE FROM users WHERE id = ${w.userId}`;
  }
  for (const u of [casey, bClient, lClient]) await sql`DELETE FROM users WHERE id = ${u.userId}`;
  await sql`DELETE FROM rate_limits WHERE key LIKE 'pkg:%'`.catch(() => {});
}

run().then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}).catch((err) => {
  console.error('Fatal:', err.message, err.stack);
  process.exit(1);
});
