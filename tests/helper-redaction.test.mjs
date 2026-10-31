// Helpers see the schedule, never the money or the full client book.
//   • schedule-only helper: GET /api/clients and /api/clients/:id return
//     { id, name, email, phone } only; clients permission gets the full record
//   • booking responses in helper mode (calendar, create, patch, no-show,
//     complete) carry no money fields; the owner still sees them
//   • GET /api/staff in helper mode: id, name, color, active only
//   • helpers cannot attach files to a completion
//   • DELETE /api/staff/:id drops the helper's cached membership at once
//   • the helper seat cap holds under concurrent invites
//
// Run: node --import ./tests/bootstrap.mjs ./tests/helper-redaction.test.mjs
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import { HELPER_SEATS, inviteHelper, helperMembershipsFor, helperSeatUsage, HelperError } from '../api/_lib/helpers.js';
import clientsHandler from '../api/clients/index.js';
import clientById from '../api/clients/[id].js';
import calendarIndex from '../api/calendar/index.js';
import bookingsCreate from '../api/calendar/bookings.js';
import bookingById from '../api/calendar/bookings/[id].js';
import noShow from '../api/calendar/bookings/no-show.js';
import completeHandler from '../api/calendar/bookings/complete.js';
import staffIndex from '../api/staff/index.js';
import staffById from '../api/staff/[id].js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

// Swallow outbound mail (invite emails).
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ id: 'em' }), text: async () => '{}' });

function mockRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(o) { this.body = o; return this; },
    end(s) { if (s !== undefined) { try { this.body = JSON.parse(s); } catch { this.body = s; } } return this; },
  };
}
let ipN = 0;
function req({ method = 'GET', body = {}, query = {}, cookie, headers = {} } = {}) {
  ipN++;
  return { method, url: '/test', query, body,
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', host: 'localhost:3000',
      'x-forwarded-for': `198.51.100.${(ipN % 200) + 10}`, ...(cookie ? { cookie } : {}), ...headers } };
}
const call = async (h, o) => { const r = mockRes(); await h(req(o), r); return r; };

const STAMP = Date.now();
const em = (t) => `helpred-${t}-${STAMP}@example.com`;
const userIds = [];
const wsIds = [];
async function mkUser(tag) {
  const u = await sql`INSERT INTO users (email, password_hash, name, email_verified_at)
    VALUES (${em(tag)}, 'x', ${tag}, NOW()) RETURNING id, email`;
  userIds.push(u.rows[0].id);
  return u.rows[0];
}
async function mkOwner(tag) {
  const u = await mkUser(tag);
  const w = await sql`INSERT INTO workspaces (owner_id, subscription_status, subscription_period_end, onboarded_at)
    VALUES (${u.id}, 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`;
  wsIds.push(w.rows[0].id);
  return { ...u, workspaceId: w.rows[0].id, cookie: `ivy_session=${signSession(u.id)}` };
}
async function attachHelper(workspaceId, name, userId, permissions) {
  const r = await sql`INSERT INTO staff_members (workspace_id, name, email, phone, color, hourly_rate, commission_rate, active, owner_managed, user_id, permissions)
    VALUES (${workspaceId}, ${name}, ${em(name.replace(/\s/g, ''))}, '+15555550111', '#123456', 42, 15, TRUE, TRUE, ${userId}, ${JSON.stringify(permissions)}::jsonb)
    RETURNING id`;
  return r.rows[0].id;
}
const setPerms = (staffId, p) => sql`UPDATE staff_members SET permissions = ${JSON.stringify(p)}::jsonb WHERE id = ${staffId}`;
const MONEY = ['depositPaid', 'depositPaidAt', 'bookingTotal', 'tipAmount', 'tipChargedAt', 'feeChargedAmount', 'feeChargedKind', 'giftCardCreditCents', 'clientPackageId'];
const noMoney = (b) => !!b && MONEY.every((k) => b[k] === null) && b.payment === undefined;

async function run() {
  await ensureSchemaApplied();
  const A = await mkOwner('owner');
  const hUser = await mkUser('helper');
  const hc = `ivy_session=${signSession(hUser.id)}`;
  const asA = { 'x-helper-workspace': A.workspaceId };
  const s1 = await attachHelper(A.workspaceId, 'Sam Helper', hUser.id, { schedule: true });
  const sOther = (await sql`INSERT INTO staff_members (workspace_id, name, email, phone, color, hourly_rate, commission_rate, active, owner_managed)
    VALUES (${A.workspaceId}, 'Pat Colleague', ${em('pat')}, '+15555550122', '#abcdef', 55, 20, TRUE, TRUE) RETURNING id`).rows[0].id;
  const c1 = (await sql`INSERT INTO clients (workspace_id, name, email, phone, stage, notes, lifetime_value, address, sms_consent_at, attachments)
    VALUES (${A.workspaceId}, 'Cara Client', ${em('cara')}, '+15555550133', 'active', 'secret notes', 999, '1 Private Rd', NOW(),
            '[{"url":"https://x.public.blob.vercel-storage.com/f.pdf","type":"application/pdf"}]'::jsonb) RETURNING id`).rows[0].id;
  const c2 = (await sql`INSERT INTO clients (workspace_id, name, email, phone, stage, notes)
    VALUES (${A.workspaceId}, 'Dan Other', ${em('dan')}, NULL, 'lead', 'more notes') RETURNING id`).rows[0].id;
  const bk = (await sql`INSERT INTO bookings (workspace_id, client_id, client_name, client_email, date, start_min, end_min, staff_id,
      booking_total, deposit_paid, deposit_paid_at, tip_amount, tip_charged_at, gift_card_credit_cents)
    VALUES (${A.workspaceId}, ${c1}, 'Cara Client', ${em('cara')}, CURRENT_DATE - 1, 600, 660, ${s1}, 150, 50, NOW(), 10, NOW(), 500)
    RETURNING id, date::text AS d`).rows[0];

  console.log('\n[1] schedule-only helper reads a minimal client book');
  let r = await call(clientsHandler, { cookie: hc, headers: asA });
  const list = r.body?.clients || [];
  assert(r.statusCode === 200 && list.some((c) => c.id === c1) && list.some((c) => c.id === c2), `GET /api/clients 200 with every A client (schedule) (${r.statusCode})`);
  assert(list.length > 0 && list.every((c) => JSON.stringify(Object.keys(c).sort()) === JSON.stringify(['email', 'id', 'name', 'phone'])), 'each client is exactly { id, name, email, phone }');
  const cara = list.find((c) => c.id === c1);
  assert(cara && cara.phone === '+15555550133' && cara.notes === undefined && cara.lifetimeValue === undefined && cara.address === undefined, 'no notes / lifetimeValue / address');
  r = await call(clientsHandler, { cookie: hc, headers: asA, query: { email: em('cara') } });
  assert(r.statusCode === 200 && r.body.clients.length === 1 && Object.keys(r.body.clients[0]).length === 4, 'email lookup also minimal');
  r = await call(clientById, { cookie: hc, headers: asA, query: { id: c1 } });
  assert(r.statusCode === 200 && JSON.stringify(Object.keys(r.body.client).sort()) === JSON.stringify(['email', 'id', 'name', 'phone']), 'GET /api/clients/:id minimal');
  r = await call(clientsHandler, { cookie: hc, headers: asA, query: { limit: '1' } });
  assert(r.statusCode === 200 && r.body.clients.length === 1 && r.body.hasMore === true, 'pagination still works in helper mode');
  await setPerms(s1, { schedule: true, clients: true });
  r = await call(clientById, { cookie: hc, headers: asA, query: { id: c1 } });
  assert(r.statusCode === 200 && r.body.client.notes === 'secret notes' && r.body.client.lifetimeValue === 999, 'clients permission → full record');
  r = await call(clientById, { cookie: A.cookie, query: { id: c1 } });
  assert(r.body.client.notes === 'secret notes' && Array.isArray(r.body.client.attachments), 'owner unaffected');
  await setPerms(s1, { schedule: true });

  console.log('\n[2] booking responses carry no money in helper mode');
  r = await call(calendarIndex, { cookie: hc, headers: asA, query: { from: bk.d, to: bk.d } });
  let b = (r.body?.calendar?.bookings || []).find((x) => x.id === bk.id);
  assert(r.statusCode === 200 && noMoney(b), `GET /api/calendar: money fields null, no payment (${JSON.stringify(b && MONEY.map((k) => b[k]))})`);
  assert(b && b.clientName === 'Cara Client' && b.startMin === 600, 'schedule details still there');
  r = await call(calendarIndex, { cookie: A.cookie, query: { from: bk.d, to: bk.d } });
  b = (r.body?.calendar?.bookings || []).find((x) => x.id === bk.id);
  assert(b && b.bookingTotal === 150 && b.depositPaid === 50 && b.tipAmount === 10 && b.payment, 'owner calendar keeps the money');
  r = await call(bookingsCreate, { method: 'POST', cookie: hc, headers: asA, body: {
    date: '2031-05-05', startMin: 600, endMin: 660, clientId: c1, clientName: 'Cara Client', clientEmail: em('cara'), staffId: s1, skipConflictCheck: true,
  } });
  assert(r.statusCode === 201 && noMoney(r.body.booking), `POST /api/calendar/bookings: no money (${r.statusCode})`);
  const bNew = r.body.booking?.id;
  r = await call(bookingById, { method: 'PATCH', cookie: hc, headers: asA, query: { id: bk.id }, body: { notes: 'bring towels' } });
  assert(r.statusCode === 200 && noMoney(r.body.booking), `PATCH /api/calendar/bookings/:id: no money (${r.statusCode})`);
  r = await call(noShow, { method: 'POST', cookie: hc, headers: asA, body: { id: bNew } });
  assert(r.statusCode === 200 && noMoney(r.body.booking), `POST no-show: no money (${r.statusCode})`);
  r = await call(noShow, { method: 'DELETE', cookie: hc, headers: asA, body: { id: bNew } });
  assert(r.statusCode === 200 && noMoney(r.body.booking), 'DELETE no-show: no money');

  console.log('\n[3] helper completion: no money, no files');
  r = await call(completeHandler, { method: 'POST', cookie: hc, headers: asA, body: {
    id: bk.id, occurrenceDate: bk.d, completionNotes: 'went well',
    completionAttachments: [{ url: `https://x.public.blob.vercel-storage.com/ws/${A.workspaceId}/f.png`, mimeType: 'image/png' }],
  } });
  assert(r.statusCode === 200 && noMoney(r.body.booking), `POST complete: no money (${r.statusCode} ${JSON.stringify(r.body).slice(0, 80)})`);
  let entry = (await sql`SELECT completion_log FROM bookings WHERE id = ${bk.id}`).rows[0].completion_log[bk.d];
  assert(entry && entry.notes === 'went well' && Array.isArray(entry.attachments) && entry.attachments.length === 0, 'attachments forced to []');
  const ownerAtt = [{ url: `https://x.public.blob.vercel-storage.com/ws/${A.workspaceId}/owner.png`, blobPathname: `ws/${A.workspaceId}/owner.png`, mimeType: 'image/png' }];
  await sql`UPDATE bookings SET completion_log = jsonb_set(completion_log, ${[bk.d]}::text[], ${JSON.stringify({ ...entry, attachments: ownerAtt })}::jsonb) WHERE id = ${bk.id}`;
  r = await call(completeHandler, { method: 'PATCH', cookie: hc, headers: asA, body: { id: bk.id, occurrenceDate: bk.d, completionNotes: 'edited', completionAttachments: [] } });
  entry = (await sql`SELECT completion_log FROM bookings WHERE id = ${bk.id}`).rows[0].completion_log[bk.d];
  assert(r.statusCode === 200 && entry.notes === 'edited' && entry.attachments.length === 1, "helper PATCH edits notes but cannot remove the owner's files");

  console.log('\n[4] staff list in helper mode is minimal');
  r = await call(staffIndex, { cookie: hc, headers: asA });
  const staff = r.body?.staff || [];
  assert(r.statusCode === 200 && staff.some((s) => s.id === sOther), `GET /api/staff 200 lists colleagues (${r.statusCode})`);
  assert(staff.every((s) => JSON.stringify(Object.keys(s).sort()) === JSON.stringify(['active', 'color', 'id', 'name'])), 'each row is exactly { id, name, color, active }');
  assert(r.body.helperSeats === undefined, 'no seat usage in helper mode');
  assert(!staff.some((s) => 'hourlyRate' in s || 'commissionRate' in s || 'email' in s || 'phone' in s || 'userId' in s || 'helper' in s), 'no pay, contact, login or invite state');
  r = await call(staffIndex, { cookie: A.cookie });
  const pat = (r.body?.staff || []).find((s) => s.id === sOther);
  assert(pat && pat.hourlyRate === 55 && pat.commissionRate === 20 && pat.email && r.body.helperSeats, 'owner still sees pay, contact and seats');

  console.log('\n[5] DELETE /api/staff/:id drops the helper cache immediately');
  const prevFlag = process.env.IVY_DISABLE_HOTCACHE;
  process.env.IVY_DISABLE_HOTCACHE = '';
  try {
    const before = await helperMembershipsFor(hUser.id); // primes the cache
    assert(before.some((m) => m.workspaceId === A.workspaceId && m.status === 'active'), 'cached membership is active');
    r = await call(staffById, { method: 'DELETE', cookie: A.cookie, query: { id: s1 } });
    assert(r.statusCode === 204 || r.statusCode === 200, `soft delete (${r.statusCode})`);
    const after = await helperMembershipsFor(hUser.id);
    assert(!after.some((m) => m.workspaceId === A.workspaceId && m.status === 'active'), 'membership gone on the very next read (cache invalidated)');
  } finally {
    process.env.IVY_DISABLE_HOTCACHE = prevFlag;
  }

  console.log('\n[6] seat cap holds when invites race');
  const C = await mkOwner('racer');
  const rows = [];
  for (let i = 0; i < 4; i++) {
    // eslint-disable-next-line no-await-in-loop
    rows.push((await sql`INSERT INTO staff_members (workspace_id, name, email, active, owner_managed)
      VALUES (${C.workspaceId}, ${`Racer ${i}`}, ${em(`racer${i}`)}, TRUE, TRUE) RETURNING *`).rows[0]);
  }
  const results = await Promise.allSettled(rows.map((staff) => inviteHelper({ workspaceId: C.workspaceId, owner: { email: C.email, name: 'Racer' }, staff })));
  const okN = results.filter((x) => x.status === 'fulfilled').length;
  const refused = results.filter((x) => x.status === 'rejected' && x.reason instanceof HelperError && x.reason.status === 409).length;
  const usage = await helperSeatUsage(C.workspaceId);
  assert(usage.used <= HELPER_SEATS, `seats used ${usage.used} <= ${HELPER_SEATS}`);
  assert(okN === HELPER_SEATS && refused === rows.length - HELPER_SEATS, `exactly ${HELPER_SEATS} invites survive, the rest get 409 (${okN} ok, ${refused} refused)`);
  const live = (await sql`SELECT COUNT(*)::int AS n FROM helper_invites WHERE workspace_id = ${C.workspaceId} AND used_at IS NULL AND cancelled_at IS NULL`).rows[0].n;
  assert(live === HELPER_SEATS, `no stray invite rows left behind (${live})`);
}

async function cleanup() {
  try {
    for (const w of wsIds) await sql`DELETE FROM workspaces WHERE id = ${w}`;
    for (const u of userIds) await sql`DELETE FROM users WHERE id = ${u}`;
  } catch (e) { console.error('cleanup:', e.message); }
}

run()
  .catch((e) => { fail++; console.error(e); })
  .finally(async () => {
    await cleanup();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  });
