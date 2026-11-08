// Push notifications, event by event, with BOTH transports stubbed:
//   web push  → web-push's sendNotification is replaced with a recorder
//   APNs      → node:http2 connect is replaced with a fake APNs server
// Each person (owner, client, helpers, another client) has one browser
// subscription and one iPhone token, so every assertion checks the right
// audience on both transports, exactly once, with the right deep link.
//
// Covers:
//   [1]  bookings: who made it is never pushed; the other side is
//   [2]  cancel + reschedule, both directions, helper on the booking
//   [3]  helper (re)assigned to a booking
//   [4]  messages owner→client and client→owner (+ helpers with access)
//   [5]  preferences: a muted type sends nothing (bell row still lands)
//   [6]  invoice paid → owner + client receipt
//   [7]  waitlist promotion → client
//   [8]  website form enquiry → owner, body never echoes form fields
//   [9]  Ivy create / reschedule booking → client
//   [10] deleted accounts get nothing
//   [11] stale device pruning (web 404/410, APNs 410 / BadDeviceToken)
//   [12] timeouts: web push 10s option, APNs per-request + batch ceiling
//   [13] keepAlive hands fire-and-forget pushes to the request context
//
// Run: node --import ./tests/bootstrap.mjs ./tests/push-events.test.mjs
import crypto from 'node:crypto';
import http2 from 'node:http2';
import webpush from 'web-push';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

// ── Outbound stubs ────────────────────────────────────────────────────
globalThis.fetch = async (url) => {
  if (String(url).includes('resend.com')) {
    return new Response(JSON.stringify({ id: 'em_test' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
};

// Web push: real VAPID keys (setVapidDetails validates them), fake send.
const vapid = webpush.generateVAPIDKeys();
process.env.VAPID_PUBLIC_KEY = vapid.publicKey;
process.env.VAPID_PRIVATE_KEY = vapid.privateKey;
const webCalls = [];
const webFail = new Map(); // endpoint → status code to fail with
webpush.sendNotification = async (sub, body, opts) => {
  webCalls.push({ endpoint: sub.endpoint, payload: JSON.parse(body), opts });
  const code = webFail.get(sub.endpoint);
  if (code) { const e = new Error(`push ${code}`); e.statusCode = code; throw e; }
  return { statusCode: 201 };
};

// APNs: a fake HTTP/2 server. tokenMode decides how each token answers.
const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
process.env.APNS_TEAM_ID = 'TEAM123456';
process.env.APNS_KEY_ID = 'KEY1234567';
process.env.APNS_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' });
const apnsCalls = [];
const tokenMode = new Map(); // token → 'gone' | 'bad' | 'error' | 'hang'
let connectMode = 'ok';      // 'ok' | 'silent' (never answers anything)
http2.connect = () => {
  const client = {
    on() { return client; },
    close() {}, destroy() {},
    request(headers) {
      const token = String(headers[':path']).split('/').pop();
      const h = {};
      const r = {
        on(ev, fn) { h[ev] = fn; return r; },
        setTimeout(ms, fn) { r.ms = ms; r.onTimeout = fn; },
        close() {},
        end(body) {
          if (connectMode === 'silent') return;
          apnsCalls.push({ token, headers, body: JSON.parse(body) });
          const mode = tokenMode.get(token) || 'ok';
          if (mode === 'hang') { setTimeout(() => r.onTimeout?.(), r.ms).unref?.(); return; }
          setImmediate(() => {
            const status = { ok: 200, gone: 410, bad: 400, error: 500 }[mode];
            h.response?.({ ':status': status });
            if (status !== 200) h.data?.(JSON.stringify({ reason: { gone: 'Unregistered', bad: 'BadDeviceToken', error: 'InternalServerError' }[mode] }));
            h.end?.();
          });
        },
      };
      return r;
    },
  };
  return client;
};

// Fire-and-forget sends register with the (fake) Vercel request context;
// flush() waits for every one of them.
const pending = [];
globalThis[Symbol.for('@vercel/request-context')] = { get: () => ({ waitUntil: (p) => pending.push(p) }) };
async function flush() {
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 15));
    if (pending.length === 0) return;
    await Promise.allSettled(pending.splice(0));
  }
}

// Handlers and libs load AFTER the stubs and env are in place.
const push = await import('../api/_lib/push.js');
const { sendApnsToTokens } = await import('../api/_lib/apns.js');
const { notifyNewBooking, notifyBookingCancellation, notifyBookingRescheduled } = await import('../api/_lib/bookingNotify.js');
const { fillFromWaitlistOnCancel } = await import('../api/_lib/waitlist.js');
const { markInvoicePaid } = await import('../api/_lib/invoicePayments.js');
const { runApprovedTool } = await import('../api/_lib/ivyTools.js');
const ownerThreadHandler = (await import('../api/messages/[id].js')).default;
const clientThreadHandler = (await import('../api/me/threads/[id].js')).default;
const bookingHandler = (await import('../api/calendar/bookings/[id].js')).default;
const formHandler = (await import('../api/website/form-submission.js')).default;

function mockRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(o) { this.body = o; return this; }, end(s) { this.body = s ?? this.body; return this; },
    writeHead(c) { this.statusCode = c; return this; },
  };
}
let ipN = 0;
function req({ method = 'GET', body = {}, query = {}, cookie } = {}) {
  ipN++;
  return { method, url: '/test', query, body,
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', host: 'localhost:3000',
      'x-forwarded-for': `198.51.${(ipN % 200) + 1}.${(ipN % 250) + 2}`, ...(cookie ? { cookie } : {}) } };
}

// ── Fixtures ──────────────────────────────────────────────────────────
const TAG = `pe${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
const people = {}; // role → { userId, cookie, endpoint, token }
const userIds = [];
let wsId, otherWsId, serviceId;

async function mkUser(role, { device = true } = {}) {
  const email = `${TAG}-${role}@example.com`;
  const u = await sql`INSERT INTO users (email, password_hash, name, email_verified_at, terms_version, terms_accepted_at)
    VALUES (${email}, 'x', ${role}, NOW(), 'v1', NOW()) RETURNING id`;
  const userId = u.rows[0].id;
  userIds.push(userId);
  const p = { userId, email, cookie: `ivy_session=${signSession(userId)}` };
  if (device) {
    p.endpoint = `https://fcm.googleapis.com/fcm/send/${TAG}-${role}`;
    p.token = crypto.randomBytes(32).toString('hex');
    await sql`INSERT INTO push_subscriptions (user_id, endpoint, p256dh_key, auth_key) VALUES (${userId}, ${p.endpoint}, 'p', 'a')`;
    await sql`INSERT INTO push_device_tokens (user_id, token, platform, last_used_at) VALUES (${userId}, ${p.token}, 'ios', NOW())`;
  }
  people[role] = p;
  return p;
}

// What a person received since `mark`: the web payloads, after checking
// the iPhone got the same notifications (same count, same titles + urls).
function got(role, mark) {
  const p = people[role];
  const web = webCalls.slice(mark.web).filter((c) => c.endpoint === p.endpoint).map((c) => c.payload);
  const ios = apnsCalls.slice(mark.apns).filter((c) => c.token === p.token).map((c) => c.body);
  const same = web.length === ios.length
    && web.every((w, i) => ios[i]?.aps?.alert?.title === w.title && (ios[i]?.url || null) === (w.url || null));
  if (!same) {
    console.log(`    (transport mismatch for ${role}: web ${web.length}, ios ${ios.length})`);
    return [...web, { mismatch: true }];
  }
  return web;
}
const mark = () => ({ web: webCalls.length, apns: apnsCalls.length });
const ROLES = ['owner', 'client', 'helper', 'helperNoMsg', 'otherClient', 'stranger'];
function onlyTo(m, expect, label) {
  for (const role of ROLES) {
    const n = got(role, m).length;
    const want = expect[role] || 0;
    assert(n === want, `${label}: ${role} got ${n} (want ${want})`);
  }
}

async function setup() {
  await ensureSchemaApplied();
  await mkUser('owner');
  await mkUser('client');
  await mkUser('helper');
  await mkUser('helperNoMsg');
  await mkUser('otherClient');
  await mkUser('stranger');
  const w = await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end)
    VALUES (${people.owner.userId}, 'Push Studio', 'active', NOW() + INTERVAL '30 days') RETURNING id`;
  wsId = w.rows[0].id;
  // The waitlist is off for a new business (1.0.6); this one uses it.
  await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug, timezone, waitlist_enabled)
    VALUES (${wsId}, 'Push Studio', ${TAG}, 'UTC', TRUE) ON CONFLICT (workspace_id) DO NOTHING`;
  // The stranger owns a different business: nothing here may reach them.
  const w2 = await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end)
    VALUES (${people.stranger.userId}, 'Elsewhere', 'active', NOW() + INTERVAL '30 days') RETURNING id`;
  otherWsId = w2.rows[0].id;

  serviceId = (await sql`INSERT INTO services (workspace_id, name, duration_minutes, price) VALUES (${wsId}, 'Cut', 60, 50) RETURNING id`).rows[0].id;
  const c = await sql`INSERT INTO clients (workspace_id, name, email, stage, user_id)
    VALUES (${wsId}, 'Casey Client', ${people.client.email}, 'active', ${people.client.userId}) RETURNING id`;
  people.client.clientId = c.rows[0].id;
  const oc = await sql`INSERT INTO clients (workspace_id, name, email, stage, user_id)
    VALUES (${wsId}, 'Olive Other', ${people.otherClient.email}, 'active', ${people.otherClient.userId}) RETURNING id`;
  people.otherClient.clientId = oc.rows[0].id;
  // Helper with schedule + messages; a second helper without messages.
  people.helper.staffId = (await sql`INSERT INTO staff_members (workspace_id, user_id, name, permissions)
    VALUES (${wsId}, ${people.helper.userId}, 'Hana Helper', '{"schedule":true,"messages":true}'::jsonb) RETURNING id`).rows[0].id;
  people.helperNoMsg.staffId = (await sql`INSERT INTO staff_members (workspace_id, user_id, name, permissions)
    VALUES (${wsId}, ${people.helperNoMsg.userId}, 'Nico NoMsg', '{"schedule":true,"messages":false}'::jsonb) RETURNING id`).rows[0].id;
}

const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
async function mkBooking({ staffId = null, date = day(5), start = 600 } = {}) {
  return (await sql`INSERT INTO bookings (workspace_id, service_id, client_id, client_name, client_email, date, start_min, end_min, staff_id)
    VALUES (${wsId}, ${serviceId}, ${people.client.clientId}, 'Casey Client', ${people.client.email}, ${date}, ${start}, ${start + 60}, ${staffId})
    RETURNING id`).rows[0].id;
}

async function run() {
  await setup();

  console.log('\n[1] new bookings: the side that did not make it is told');
  let b = await mkBooking();
  let m = mark();
  await notifyNewBooking({ workspaceId: wsId, bookingId: b, source: 'public' });
  await flush();
  onlyTo(m, { owner: 1 }, 'the first ever client booking: one push, not two');
  assert(got('owner', m)[0]?.title === 'Your first booking is in.', 'it is the first-booking celebration');
  b = await mkBooking({ start: 660 });
  m = mark();
  await notifyNewBooking({ workspaceId: wsId, bookingId: b, source: 'public' });
  await flush();
  onlyTo(m, { owner: 1 }, 'public booking');
  let p = got('owner', m)[0];
  assert(p?.title === 'New booking' && p.url === `/calendar?booking=${b}`, `owner deep link opens the booking (${p?.url})`);

  m = mark();
  await notifyNewBooking({ workspaceId: wsId, bookingId: b, source: 'client-portal' });
  await flush();
  onlyTo(m, { owner: 1 }, 'client package booking from the portal');

  b = await mkBooking({ staffId: people.helper.staffId, start: 720 });
  m = mark();
  await notifyNewBooking({ workspaceId: wsId, bookingId: b, source: 'owner' });
  await flush();
  onlyTo(m, { client: 1, helper: 1 }, 'owner booked the client, helper assigned');
  p = got('client', m)[0];
  assert(p?.title === 'Booked with Push Studio' && p.url === '/me/bookings', `client push names the business and opens Bookings (${p?.title} ${p?.url})`);
  assert(!/Olive/.test(JSON.stringify(p)), 'client push carries nothing about other clients');
  assert(got('helper', m)[0]?.url?.startsWith('/helper?date='), 'helper deep link opens their day');

  console.log('\n[2] cancel + reschedule, both directions');
  m = mark();
  await notifyBookingCancellation({ workspaceId: wsId, bookingId: b, source: 'owner' });
  await flush();
  onlyTo(m, { client: 1, helper: 1 }, 'owner cancelled (owner not pushed about their own tap)');
  m = mark();
  await notifyBookingCancellation({ workspaceId: wsId, bookingId: b, source: 'client' });
  await flush();
  onlyTo(m, { owner: 1, helper: 1 }, 'client cancelled');
  assert(got('owner', m)[0]?.title === 'Booking cancelled by client', 'owner title says the client cancelled');

  m = mark();
  await notifyBookingRescheduled({ workspaceId: wsId, bookingId: b, oldDateISO: day(5), oldStartMin: 720, oldEndMin: 780, source: 'owner' });
  await flush();
  onlyTo(m, { client: 1, helper: 1 }, 'owner moved it');
  p = got('client', m)[0];
  assert(p?.title === 'Appointment moved' && p.url === '/me/bookings', `client told it moved (${p?.title})`);
  m = mark();
  await notifyBookingRescheduled({ workspaceId: wsId, bookingId: b, oldDateISO: day(5), oldStartMin: 720, oldEndMin: 780, source: 'client' });
  await flush();
  onlyTo(m, { owner: 1, helper: 1 }, 'client moved it');
  assert(got('owner', m)[0]?.url === `/calendar?booking=${b}`, 'owner reschedule push opens the booking');

  console.log('\n[3] booking (re)assigned to a helper');
  const b3 = await mkBooking({ start: 840 });
  m = mark();
  let r = mockRes();
  await bookingHandler(req({ method: 'PATCH', cookie: people.owner.cookie, query: { id: b3 }, body: { staffId: people.helperNoMsg.staffId } }), r);
  await flush();
  assert(r.statusCode === 200, `assign ok (${r.statusCode})`);
  onlyTo(m, { helperNoMsg: 1 }, 'newly assigned helper');
  m = mark();
  r = mockRes();
  await bookingHandler(req({ method: 'PATCH', cookie: people.owner.cookie, query: { id: b3 }, body: { staffId: people.helperNoMsg.staffId } }), r);
  await flush();
  onlyTo(m, {}, 'same helper saved again (no duplicate)');

  console.log('\n[4] messages');
  // The bookings above already opened this client's thread.
  const thread = (await sql`INSERT INTO message_threads (workspace_id, client_id) VALUES (${wsId}, ${people.client.clientId})
    ON CONFLICT (workspace_id, client_id) DO UPDATE SET workspace_id = EXCLUDED.workspace_id RETURNING id`).rows[0].id;
  m = mark();
  r = mockRes();
  await ownerThreadHandler(req({ method: 'POST', cookie: people.owner.cookie, query: { id: thread }, body: { text: 'See you Tuesday' } }), r);
  await flush();
  assert(r.statusCode === 201 || r.statusCode === 200, `owner sends (${r.statusCode})`);
  onlyTo(m, { client: 1 }, 'owner → client message');
  p = got('client', m)[0];
  assert(p?.body === 'See you Tuesday' && p.url === `/me/messages?threadId=${thread}`, 'client push opens the thread');

  m = mark();
  r = mockRes();
  await clientThreadHandler(req({ method: 'POST', cookie: people.client.cookie, query: { id: thread }, body: { text: 'Running 5 late' } }), r);
  await flush();
  assert(r.statusCode === 201 || r.statusCode === 200, `client sends (${r.statusCode} ${JSON.stringify(r.body).slice(0, 120)})`);
  onlyTo(m, { owner: 1, helper: 1 }, 'client → owner message (+ helper with messages permission)');
  assert(got('owner', m)[0]?.url === `/messages?threadId=${thread}`, 'owner push opens the thread');
  assert(got('helper', m)[0]?.url === `/helper/messages?threadId=${thread}`, 'helper push opens their own inbox');

  console.log('\n[5] a muted type sends nothing; the bell still records it');
  await sql`UPDATE users SET notification_prefs = '{"messages": false}'::jsonb WHERE id = ${people.client.userId}`;
  m = mark();
  r = mockRes();
  await ownerThreadHandler(req({ method: 'POST', cookie: people.owner.cookie, query: { id: thread }, body: { text: 'Muted test' } }), r);
  await flush();
  onlyTo(m, {}, 'client muted messages');
  const bell = await sql`SELECT body FROM notifications WHERE user_id = ${people.client.userId} AND tag = ${`thread-${thread}`}`;
  assert(bell.rows[0]?.body === 'Muted test', 'bell row still updated');
  await sql`UPDATE users SET notification_prefs = '{}'::jsonb WHERE id = ${people.client.userId}`;

  console.log('\n[6] invoice paid');
  // Steady state (the one-time "Your first payment is in." celebration is
  // covered by first-win.test.mjs).
  await sql`UPDATE workspaces SET first_payment_celebrated_at = NOW() WHERE id = ${wsId}`;
  await sql`INSERT INTO invoices (workspace_id, client_name, number, status, items, tax_rate, discount, total, paid_amount, paid_at)
    VALUES (${wsId}, 'Earlier', ${`INV-${TAG}-0`}, 'paid', '[{"description":"x","quantity":1,"rate":10}]'::jsonb, 0, 0, 10, 10, NOW())`;
  const inv = (await sql`INSERT INTO invoices (workspace_id, client_id, client_name, client_email, number, status, items, tax_rate, discount)
    VALUES (${wsId}, ${people.client.clientId}, 'Casey Client', ${people.client.email}, ${`INV-${TAG}`}, 'sent',
            '[{"description":"Cut","quantity":1,"rate":50}]'::jsonb, 0, 0) RETURNING id`).rows[0].id;
  m = mark();
  const out = await markInvoicePaid({ workspaceId: wsId, invoiceId: inv, paymentIntent: null, method: 'card' });
  await flush();
  assert(out === 'paid', `invoice marked paid (${out})`);
  onlyTo(m, { owner: 1, client: 1 }, 'invoice paid');
  assert(got('owner', m)[0]?.url === `/finance?invoice=${inv}`, 'owner push opens the invoice');

  console.log('\n[7] waitlist spot opens');
  const wDate = day(9);
  await sql`INSERT INTO waitlist_entries (workspace_id, service_id, client_id, client_name, client_email, date, start_min, end_min)
    VALUES (${wsId}, ${serviceId}, ${people.client.clientId}, 'Casey Client', ${people.client.email}, ${wDate}, 600, 660)`;
  m = mark();
  // 1.0.6: the spot is OFFERED with a one-tap claim link (nobody is booked
  // without their tap); the push opens the claim page.
  const offer = await fillFromWaitlistOnCancel({ workspaceId: wsId, serviceId, dateISO: wDate, startMin: 600, endMin: 660 });
  await flush();
  assert(!!offer, 'the spot is offered');
  onlyTo(m, { client: 1 }, 'waitlist offer');
  assert(/^\/book\/[^?]+\?claim=/.test(got('client', m)[0]?.url || ''), `opens the claim page (${got('client', m)[0]?.url})`);

  console.log('\n[8] website enquiry');
  const handle = `${TAG}-site`;
  await sql`INSERT INTO websites (workspace_id, handle, business_name, published_at) VALUES (${wsId}, ${handle}, 'Push Studio', NOW())`;
  m = mark();
  r = mockRes();
  await formHandler(req({ method: 'POST', body: { handle, formId: 'contact', payload: { name: 'Lee Lead', email: `${TAG}-lead@example.com`, message: 'my private health detail' } } }), r);
  await flush();
  assert(r.statusCode === 200, `form accepted (${r.statusCode})`);
  onlyTo(m, { owner: 1 }, 'website form');
  p = got('owner', m)[0];
  assert(p?.title === 'New website enquiry' && /Lee Lead/.test(p.body), 'owner sees who wrote');
  assert(!/private health/.test(p?.body || ''), 'free-text field is not on the lock screen');
  assert(/^\/clients\?id=[0-9a-f-]{36}$/.test(p?.url || ''), `opens the new lead (${p?.url})`);

  console.log('\n[9] Ivy books and moves appointments → the client is told');
  const ctx = { workspaceId: wsId, userId: people.owner.userId };
  m = mark();
  const made = await runApprovedTool('create_booking', { client_id: people.client.clientId, date: day(11), start_min: 600, end_min: 660, service_id: serviceId }, ctx);
  await flush();
  assert(!!made?.booking?.id, `Ivy booked (${JSON.stringify(made).slice(0, 100)})`);
  onlyTo(m, { client: 1 }, 'Ivy create_booking');
  m = mark();
  const moved = await runApprovedTool('reschedule_booking', { booking_id: made?.booking?.id, date: day(12), start_min: 660, end_min: 720 }, ctx);
  await flush();
  assert(moved?.rescheduled === true, 'Ivy rescheduled');
  onlyTo(m, { client: 1 }, 'Ivy reschedule_booking');

  console.log('\n[10] deleted accounts get nothing');
  await sql`UPDATE users SET deleted_at = NOW() WHERE id = ${people.otherClient.userId}`;
  m = mark();
  const res10 = await push.notifyClient({ clientId: people.otherClient.clientId, type: 'messages', payload: { title: 'x', body: 'y' } });
  assert((res10?.sent || 0) === 0, 'deleted client user: sent 0');
  onlyTo(m, {}, 'deleted user');
  // And the stranger (another business) never got a single push in this run.
  assert(webCalls.every((c) => c.endpoint !== people.stranger.endpoint) && apnsCalls.every((c) => c.token !== people.stranger.token),
    'the other business owner received nothing all run');

  console.log('\n[11] dead devices are pruned, live ones kept');
  const extra = { e404: `https://fcm.googleapis.com/fcm/send/${TAG}-404`, e410: `https://fcm.googleapis.com/fcm/send/${TAG}-410`, e500: `https://fcm.googleapis.com/fcm/send/${TAG}-500` };
  for (const e of Object.values(extra)) await sql`INSERT INTO push_subscriptions (user_id, endpoint, p256dh_key, auth_key) VALUES (${people.owner.userId}, ${e}, 'p', 'a')`;
  webFail.set(extra.e404, 404); webFail.set(extra.e410, 410); webFail.set(extra.e500, 500);
  const tGone = crypto.randomBytes(32).toString('hex');
  const tBad = crypto.randomBytes(32).toString('hex');
  const tErr = crypto.randomBytes(32).toString('hex');
  for (const t of [tGone, tBad, tErr]) await sql`INSERT INTO push_device_tokens (user_id, token, platform) VALUES (${people.owner.userId}, ${t}, 'ios')`;
  tokenMode.set(tGone, 'gone'); tokenMode.set(tBad, 'bad'); tokenMode.set(tErr, 'error');
  const res11 = await push.sendPushToUser({ userId: people.owner.userId, payload: { title: 'Prune check', url: '/dashboard' } });
  const subs = (await sql`SELECT endpoint FROM push_subscriptions WHERE user_id = ${people.owner.userId}`).rows.map((x) => x.endpoint);
  const toks = (await sql`SELECT token FROM push_device_tokens WHERE user_id = ${people.owner.userId}`).rows.map((x) => x.token);
  assert(!subs.includes(extra.e404) && !subs.includes(extra.e410), 'web 404 + 410 subscriptions deleted');
  assert(subs.includes(extra.e500) && subs.includes(people.owner.endpoint), 'web 500 (transient) and the good one kept');
  assert(!toks.includes(tGone) && !toks.includes(tBad), 'APNs 410 Unregistered + BadDeviceToken tokens deleted');
  assert(toks.includes(tErr) && toks.includes(people.owner.token), 'APNs 500 (transient) and the good token kept');
  assert(res11.sent === 2, `sent counts only real deliveries (got ${res11.sent})`);

  console.log('\n[12] timeouts');
  const last = webCalls[webCalls.length - 1];
  assert(last?.opts?.timeout === 10_000, `web push gives up after 10s (opts.timeout=${last?.opts?.timeout})`);
  const tHang = crypto.randomBytes(32).toString('hex');
  tokenMode.set(tHang, 'hang');
  let t0 = Date.now();
  let res12 = await sendApnsToTokens({ tokens: [tHang], payload: { title: 't' }, requestTimeoutMs: 50, ceilingMs: 2000 });
  assert(res12[0]?.kind === 'error' && res12[0]?.reason === 'timeout' && Date.now() - t0 < 1500, 'APNs request that never answers times out');
  connectMode = 'silent';
  t0 = Date.now();
  res12 = await sendApnsToTokens({ tokens: [tHang], payload: { title: 't' }, requestTimeoutMs: 5000, ceilingMs: 100 });
  connectMode = 'ok';
  assert(res12[0]?.kind === 'error' && Date.now() - t0 < 1500, 'a connection that never opens hits the batch ceiling');
  const { APNS_REQUEST_TIMEOUT_MS, APNS_BATCH_CEILING_MS } = await import('../api/_lib/apns.js');
  assert(APNS_REQUEST_TIMEOUT_MS === 10_000 && APNS_BATCH_CEILING_MS === 15_000, 'production APNs limits are 10s per request, 15s per batch');

  console.log('\n[13] keepAlive');
  const before = pending.length;
  push.notifyOwnerSafe({ workspaceId: wsId, type: 'support', payload: { title: 'keepalive' } });
  assert(pending.length === before + 1, 'fire-and-forget push handed to waitUntil');
  await flush();
}

try {
  await run();
} catch (err) {
  console.error('Fatal:', err.message, err.stack);
  fail++;
} finally {
  await sql`DELETE FROM websites WHERE handle LIKE ${TAG + '%'}`.catch(() => {});
  for (const ws of [wsId, otherWsId].filter(Boolean)) await sql`DELETE FROM workspaces WHERE id = ${ws}`.catch(() => {});
  for (const id of userIds) {
    await sql`DELETE FROM push_device_tokens WHERE user_id = ${id}`.catch(() => {});
    await sql`DELETE FROM push_subscriptions WHERE user_id = ${id}`.catch(() => {});
    await sql`DELETE FROM notifications WHERE user_id = ${id}`.catch(() => {});
    await sql`DELETE FROM users WHERE id = ${id}`.catch(() => {});
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
