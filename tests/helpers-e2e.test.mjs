// Helpers ("bring your assistant along"): invite → accept → a deliberately
// small view. Proves the whole lifecycle against the real handlers:
//   • invite creates one record, sends one email, link is single-use + 7-day
//   • accept attaches an existing account or creates a new one (no workspace)
//   • seat cap (HELPER_SEATS = 2), owner's own email refused
//   • helper sees only their own bookings and only the clients they meet
//   • helper is refused on every owner endpoint; helper of A sees nothing of B
//   • revoke cuts access immediately and /api/me keeps the link as 'revoked'
//   • owner's lapsed subscription pauses helper access (402)
//   • owner purge leaves the helper's own users row intact
//   • helper account delete only detaches them
//
// Run: node --import ./tests/bootstrap.mjs ./tests/helpers-e2e.test.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import { CURRENT_TERMS_VERSION, CURRENT_PRIVACY_VERSION } from '../api/_lib/legal.js';
import { HELPER_SEATS } from '../api/_lib/helpers.js';
import { evictWorkspaceGateCache } from '../api/_lib/workspaceGate.js';
import { purgeWorkspaceData } from '../api/_lib/dataRetention.js';
import staffIndex from '../api/staff/index.js';
import staffInvite from '../api/staff/[id]/invite.js';
import staffRevoke from '../api/staff/[id]/revoke.js';
import helperInvite from '../api/helper/invite.js';
import helperAccept from '../api/helper/accept.js';
import helperMe from '../api/helper/me.js';
import helperSchedule from '../api/helper/schedule.js';
import helperClients from '../api/helper/clients-for-my-bookings.js';
import helperComplete from '../api/helper/bookings/[id]/complete.js';
import helperNoShow from '../api/helper/bookings/[id]/no-show.js';
import helperStart from '../api/helper/start-business.js';
import meHandler from '../api/me/index.js';
import clientsHandler from '../api/clients/index.js';
import invoicesHandler from '../api/invoices/index.js';
import ivyHandler from '../api/ivy/index.js';
import financeHandler from '../api/finance/index.js';
import ownerComplete from '../api/calendar/bookings/complete.js';
import accountDelete from '../api/account/delete.js';
import calendarIndex from '../api/calendar/index.js';
import bookingsCreate from '../api/calendar/bookings.js';
import bookingById from '../api/calendar/bookings/[id].js';
import ownerNoShow from '../api/calendar/bookings/no-show.js';
import clientById from '../api/clients/[id].js';
import staffById from '../api/staff/[id].js';
import messagesIndex from '../api/messages/index.js';
import messageThread from '../api/messages/[id].js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

// Capture outbound mail in-process.
const realFetch = globalThis.fetch;
const emails = [];
globalThis.fetch = async (url, init) => {
  if (String(url).includes('resend.com')) {
    try { emails.push(JSON.parse(init?.body || '{}')); } catch { emails.push({}); }
    return { ok: true, status: 200, json: async () => ({ id: `em_${emails.length}` }), text: async () => '{}' };
  }
  return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
};

function mockRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { const key = k.toLowerCase(); if (key === 'set-cookie') { (this.headers[key] ||= []).push(...(Array.isArray(v) ? v : [v])); } else { this.headers[key] = v; } },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(o) { this.body = o; return this; }, end(s) { if (s !== undefined) { try { this.body = JSON.parse(s); } catch { this.body = s; } } return this; },
    writeHead(c) { this.statusCode = c; return this; },
  };
}
let ipN = 0;
function req({ method = 'GET', body = {}, query = {}, cookie, ip, headers = {} } = {}) {
  ipN++;
  return { method, url: '/test', query, body,
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', host: 'localhost:3000',
      'x-forwarded-for': ip || `203.0.113.${(ipN % 200) + 10}`, ...(cookie ? { cookie } : {}), ...headers } };
}
const call = async (handler, opts) => { const r = mockRes(); await handler(req(opts), r); return r; };
const cookieFor = (userId) => `ivy_session=${signSession(userId)}`;

const STAMP = Date.now();
const em = (tag) => `helpers-${tag}-${STAMP}@example.com`;
const userIds = [];

async function mkUser(tag, name) {
  const r = await sql`INSERT INTO users (email, password_hash, name, email_verified_at)
    VALUES (${em(tag)}, 'x', ${name}, NOW()) RETURNING id, email`;
  userIds.push(r.rows[0].id);
  return r.rows[0];
}
async function mkOwner(tag, bizName) {
  const u = await mkUser(tag, `${bizName} Owner`);
  const w = await sql`INSERT INTO workspaces (owner_id, subscription_status, subscription_period_end, onboarded_at)
    VALUES (${u.id}, 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`;
  await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug) VALUES (${w.rows[0].id}, ${bizName}, ${`h-${tag}-${STAMP}`})`;
  return { ...u, workspaceId: w.rows[0].id, cookie: cookieFor(u.id) };
}
async function mkStaff(workspaceId, name, email) {
  const r = await sql`INSERT INTO staff_members (workspace_id, name, email, active, owner_managed)
    VALUES (${workspaceId}, ${name}, ${email}, TRUE, TRUE) RETURNING id`;
  return r.rows[0].id;
}
async function mkClient(workspaceId, name, email, phone) {
  const r = await sql`INSERT INTO clients (workspace_id, name, email, phone, stage) VALUES (${workspaceId}, ${name}, ${email}, ${phone}, 'active') RETURNING id`;
  return r.rows[0].id;
}
async function mkBooking(workspaceId, { clientId, clientName, staffId = null, dayOffset = 1, start = 600, serviceId = null, notes = null }) {
  const r = await sql`INSERT INTO bookings (workspace_id, service_id, client_id, client_name, client_email, date, start_min, end_min, staff_id, notes)
    VALUES (${workspaceId}, ${serviceId}, ${clientId}, ${clientName}, ${'c@example.com'}, CURRENT_DATE + ${dayOffset}::int, ${start}, ${start + 60}, ${staffId}, ${notes}) RETURNING id, date`;
  return r.rows[0];
}
const staffRow = async (id) => (await sql`SELECT * FROM staff_members WHERE id = ${id}`).rows[0];
const tokenFromEmail = (e) => (e?.html || '').match(/\/helper\/invite\/([A-Za-z0-9_-]+)/)?.[1] || null;
const lastEmail = () => emails[emails.length - 1];
const NEW_PW = 'a-long-enough-pass-123';
const terms = { acceptedTermsVersion: CURRENT_TERMS_VERSION, acceptedPrivacyVersion: CURRENT_PRIVACY_VERSION };

async function run() {
  try {
    await ensureSchemaApplied();
    const A = await mkOwner('ownerA', 'Maple Studio');
    const B = await mkOwner('ownerB', 'Cedar Fitness');
    const s1 = await mkStaff(A.workspaceId, 'Sam Helper', em('h1'));
    const s2 = await mkStaff(A.workspaceId, 'Second Shooter', em('h2'));
    const s3 = await mkStaff(A.workspaceId, 'Saturday Cover', em('h5'));
    const s4 = await mkStaff(A.workspaceId, 'Existing Account', em('h3'));
    const s5 = await mkStaff(A.workspaceId, 'Owner Twin', A.email);
    const sB = await mkStaff(B.workspaceId, 'Cedar Helper', em('h4'));

    console.log('\n[1] invite creates one link, sends one email');
    const before = emails.length;
    let r = await call(staffInvite, { method: 'POST', cookie: A.cookie, query: { id: s1 } });
    assert(r.statusCode === 200, `invite 200 (got ${r.statusCode}: ${JSON.stringify(r.body)})`);
    assert(emails.length === before + 1, 'exactly one email sent');
    assert(lastEmail().subject === 'Maple Studio invited you to help out on Ivy', `subject reads "${lastEmail().subject}"`);
    assert(String(lastEmail().to) === em('h1') || lastEmail().to?.[0] === em('h1'), 'sent to the helper email');
    const tok1 = tokenFromEmail(lastEmail());
    assert(!!tok1 && tok1.length >= 32, 'email carries a signed /helper/invite/<token> link');
    assert(r.body.staff.helper.status === 'invited', 'staff status = invited');
    const inv1 = (await sql`SELECT * FROM helper_invites WHERE staff_member_id = ${s1}`).rows;
    assert(inv1.length === 1 && !inv1[0].token_hash.includes(tok1), 'one invite row, raw token not stored (hash only)');
    const ttlDays = (new Date(inv1[0].expires_at) - Date.now()) / 86400e3;
    assert(ttlDays > 6.9 && ttlDays <= 7.01, `expires in ~7 days (${ttlDays.toFixed(2)})`);
    r = await call(staffIndex, { cookie: A.cookie });
    assert(r.body.helperSeats.used === 1 && r.body.helperSeats.seats === HELPER_SEATS, `seat usage 1 of ${HELPER_SEATS} (pending counts)`);

    console.log('\n[2] public preview + accept creates a new account and attaches it');
    r = await call(helperInvite, { query: { token: tok1 } });
    assert(r.statusCode === 200 && r.body.hasAccount === false && r.body.businessName === 'Maple Studio', 'preview: business named, no account yet');
    r = await call(helperAccept, { method: 'POST', body: { token: tok1, name: 'Sam Helper', password: NEW_PW, ...terms } });
    assert(r.statusCode === 200 && r.body.created === true, `accept 200 created (got ${r.statusCode}: ${JSON.stringify(r.body)})`);
    assert((r.headers['set-cookie'] || []).some((c) => c.startsWith('ivy_session=')), 'session cookie set for the new account');
    const h1 = (await sql`SELECT id, email_verified_at FROM users WHERE email = ${em('h1')}`).rows[0];
    userIds.push(h1.id);
    assert(!!h1 && !!h1.email_verified_at, 'user row created, email counted as verified');
    let row = await staffRow(s1);
    assert(row.user_id === h1.id && !!row.accepted_at, 'staff_members.user_id set + accepted_at stamped');
    const noWs = await sql`SELECT id FROM workspaces WHERE owner_id = ${h1.id}`;
    assert(noWs.rows.length === 0, 'no workspace minted for the helper');
    const h1c = cookieFor(h1.id);

    console.log('\n[3] the link is single-use');
    r = await call(helperAccept, { method: 'POST', body: { token: tok1, name: 'Again', password: NEW_PW, ...terms } });
    assert(r.statusCode === 400, `second accept refused (${r.statusCode})`);
    r = await call(helperInvite, { query: { token: tok1 } });
    assert(r.statusCode === 410 && r.body.status === 'used', 'preview of a used link: 410 used');

    console.log('\n[4] the link expires');
    r = await call(staffInvite, { method: 'POST', cookie: A.cookie, query: { id: s2 } });
    const tok2 = tokenFromEmail(lastEmail());
    await sql`UPDATE helper_invites SET expires_at = NOW() - INTERVAL '1 day' WHERE staff_member_id = ${s2}`;
    r = await call(helperInvite, { query: { token: tok2 } });
    assert(r.statusCode === 410 && r.body.status === 'expired', 'preview of an expired link: 410 expired');
    r = await call(helperAccept, { method: 'POST', body: { token: tok2, name: 'Late', password: NEW_PW, ...terms } });
    assert(r.statusCode === 400, 'accept of an expired link refused');
    r = await call(staffIndex, { cookie: A.cookie });
    assert(r.body.helperSeats.used === 1, 'an expired invite frees its seat');

    console.log('\n[5] seat limit: 2 helpers, pending invites count');
    r = await call(staffInvite, { method: 'POST', cookie: A.cookie, query: { id: s2 } });
    assert(r.statusCode === 200, 'resend to s2 → fresh link');
    const tok2b = tokenFromEmail(lastEmail());
    r = await call(helperInvite, { query: { token: tok2 } });
    assert(r.statusCode === 410 && r.body.status === 'cancelled', 'resend cancels the earlier link');
    r = await call(staffInvite, { method: 'POST', cookie: A.cookie, query: { id: s3 } });
    assert(r.statusCode === 409 && /2 helpers/.test(r.body.error), `third seat refused: "${r.body.error}"`);
    r = await call(staffIndex, { method: 'POST', cookie: A.cookie, body: { name: 'Fourth', email: em('h6'), invite: true } });
    assert(r.statusCode === 409, 'Add helper (create + invite) also refused at the cap');
    const fourth = await sql`SELECT id FROM staff_members WHERE workspace_id = ${A.workspaceId} AND name = 'Fourth'`;
    assert(fourth.rows.length === 0, 'no stray staff record left behind');
    r = await call(staffInvite, { method: 'DELETE', cookie: A.cookie, query: { id: s2 } });
    assert(r.statusCode === 200 && r.body.staff.helper.status === null, 'cancel invite → status cleared');
    r = await call(helperInvite, { query: { token: tok2b } });
    assert(r.statusCode === 410 && r.body.status === 'cancelled' && r.body.error === "Looks like you're no longer part of this team on Ivy.", 'cancelled link reads the friendly line, no business name');
    r = await call(staffInvite, { method: 'POST', cookie: A.cookie, query: { id: s3 } });
    assert(r.statusCode === 200, 'seat freed → s3 invited');

    console.log('\n[6] the owner\'s own email is refused');
    r = await call(staffInvite, { method: 'POST', cookie: A.cookie, query: { id: s5 } });
    assert(r.statusCode === 400 && /own email/.test(r.body.error), `owner email refused: "${r.body.error}"`);
    r = await call(staffIndex, { method: 'POST', cookie: A.cookie, body: { name: 'Me', email: A.email.toUpperCase(), invite: true } });
    assert(r.statusCode === 400, 'Add helper with the owner email refused (case-insensitive)');

    console.log('\n[7] accept attaches an EXISTING account (must be signed in as that email)');
    await call(staffInvite, { method: 'DELETE', cookie: A.cookie, query: { id: s3 } });
    const h3 = await mkUser('h3', 'Already Here');
    r = await call(staffInvite, { method: 'POST', cookie: A.cookie, query: { id: s4 } });
    const tok4 = tokenFromEmail(lastEmail());
    r = await call(helperInvite, { query: { token: tok4 } });
    assert(r.body.hasAccount === true, 'preview: hasAccount');
    r = await call(helperAccept, { method: 'POST', body: { token: tok4 } });
    assert(r.statusCode === 401 && r.body.error === 'sign-in-required', 'no session → sign-in-required');
    r = await call(helperAccept, { method: 'POST', cookie: A.cookie, body: { token: tok4 } });
    assert(r.statusCode === 403 && r.body.error === 'wrong-account', 'signed in as someone else → wrong-account');
    r = await call(helperAccept, { method: 'POST', cookie: cookieFor(h3.id), body: { token: tok4 } });
    assert(r.statusCode === 200 && r.body.created === false, 'signed in as the invitee → attached');
    row = await staffRow(s4);
    assert(row.user_id === h3.id, 'existing account attached to the staff record');
    r = await call(staffIndex, { cookie: A.cookie });
    const byId = Object.fromEntries(r.body.staff.map((s) => [s.id, s]));
    assert(byId[s1].helper.status === 'active' && byId[s4].helper.status === 'active' && byId[s2].helper.status === null, 'drawer statuses: active / active / none');
    assert(r.body.helperSeats.used === 2 && r.body.helperSeats.attached === 2, 'seats 2 of 2 used');

    console.log('\n[8] /api/me shape for a helper');
    r = await call(meHandler, { cookie: h1c });
    assert(r.statusCode === 200 && r.body.isHelper === true && r.body.isOwner === false && r.body.isClient === false, 'isHelper true, not owner/client');
    assert(Array.isArray(r.body.helps) && r.body.helps.length === 1, 'helps has one entry');
    const hp = r.body.helps[0];
    assert(hp.workspaceId === A.workspaceId && hp.businessName === 'Maple Studio' && hp.staffId === s1 && hp.status === 'active' && hp.active === true,
      'helps[0] = { workspaceId, businessName, staffId, status: active, active: true }');
    assert(hp.permissions && hp.permissions.schedule === false && hp.permissions.clients === false && hp.permissions.messages === false,
      'helps[0].permissions default to all false');
    assert(r.body.subscription === null && r.body.isOwner === false && r.body.hasBillingRecord === false && r.body.onboardedAt === null,
      '/api/me for a helper carries no subscription / paywall state at all');

    console.log('\n[9] helper sees only their own bookings and only the clients they meet');
    const svc = await sql`INSERT INTO services (workspace_id, name, duration_minutes, price, location_type, location_label)
      VALUES (${A.workspaceId}, 'Portrait session', 60, 150, 'in_person', 'Studio 2') RETURNING id`;
    const c1 = await mkClient(A.workspaceId, 'Client One', 'one@example.com', '+15550000001');
    const c2 = await mkClient(A.workspaceId, 'Client Two', 'two@example.com', '+15550000002');
    const c3 = await mkClient(A.workspaceId, 'Client Three', 'three@example.com', '+15550000003');
    const b1 = await mkBooking(A.workspaceId, { clientId: c1, clientName: 'Client One', staffId: s1, serviceId: svc.rows[0].id, notes: 'Bring the reflector' });
    const b2 = await mkBooking(A.workspaceId, { clientId: c2, clientName: 'Client Two', staffId: s4, start: 720 });
    await mkBooking(A.workspaceId, { clientId: c3, clientName: 'Client Three', staffId: null, start: 840 });
    const b5 = await mkBooking(A.workspaceId, { clientId: c1, clientName: 'Client One', staffId: s1, dayOffset: -1, start: 540 });
    const cB = await mkClient(B.workspaceId, 'Cedar Client', 'cedar@example.com', null);
    await mkBooking(B.workspaceId, { clientId: cB, clientName: 'Cedar Client', staffId: sB });
    r = await call(helperSchedule, { cookie: h1c });
    assert(r.statusCode === 200, `schedule 200 (${r.statusCode})`);
    const ids = (r.body.bookings || []).map((b) => b.id).sort();
    assert(ids.length === 2 && ids.includes(b1.id) && ids.includes(b5.id), 'only the two bookings assigned to this helper');
    const mine = r.body.bookings.find((b) => b.id === b1.id);
    assert(mine.serviceName === 'Portrait session' && mine.locationLabel === 'Studio 2' && mine.notes === 'Bring the reflector' && mine.clientName === 'Client One', 'row carries service, location, notes, client name');
    assert(!('bookingTotal' in mine) && !('depositPaid' in mine) && !('payment' in mine), 'no money fields on the helper shape');
    r = await call(helperClients, { cookie: h1c });
    assert(r.body.clients.length === 1 && r.body.clients[0].id === c1 && r.body.clients[0].phone === '+15550000001', 'contact details only for the client they are booked with');
    r = await call(helperSchedule, { cookie: h1c, query: { workspaceId: B.workspaceId } });
    assert(r.statusCode === 403, 'asking for another workspace → 403');

    console.log('\n[10] mark complete / no-show on own bookings only (shared completion logic)');
    const d1 = b1.date instanceof Date ? b1.date.toISOString().slice(0, 10) : b1.date;
    r = await call(helperComplete, { method: 'POST', cookie: h1c, query: { id: b1.id }, body: { occurrenceDate: d1, notes: 'Went well' } });
    assert(r.statusCode === 200 && r.body.booking.completed[d1]?.notes === 'Went well', `complete 200 (${r.statusCode}: ${JSON.stringify(r.body).slice(0, 120)})`);
    const logRow = (await sql`SELECT completion_log FROM bookings WHERE id = ${b1.id}`).rows[0].completion_log;
    assert(logRow[d1].completedByStaffId === s1 && logRow[d1].completedByUserId === h1.id && logRow[d1].visibleToClient === true, 'completion_log attributes the helper (staff + user)');
    r = await call(helperComplete, { method: 'POST', cookie: h1c, query: { id: b1.id }, body: { occurrenceDate: d1 } });
    assert(r.statusCode === 400, 'completing twice refused');
    const d2 = b2.date instanceof Date ? b2.date.toISOString().slice(0, 10) : b2.date;
    r = await call(helperComplete, { method: 'POST', cookie: h1c, query: { id: b2.id }, body: { occurrenceDate: d2 } });
    assert(r.statusCode === 404, "someone else's booking → 404");
    r = await call(helperNoShow, { method: 'POST', cookie: h1c, query: { id: b5.id }, body: {} });
    assert(r.statusCode === 200 && !!r.body.booking.noShowAt, 'no-show marked');
    const fee = (await sql`SELECT fee_charged_amount, fee_charged_at FROM bookings WHERE id = ${b5.id}`).rows[0];
    assert(Number(fee.fee_charged_amount || 0) === 0 && fee.fee_charged_at == null, 'helper no-show never charges a fee');
    r = await call(helperNoShow, { method: 'DELETE', cookie: h1c, query: { id: b5.id }, body: {} });
    assert(r.statusCode === 200 && r.body.undone === true, 'no-show undone');
    r = await call(helperComplete, { method: 'DELETE', cookie: h1c, query: { id: b1.id }, body: { occurrenceDate: d1 } });
    assert(r.statusCode === 200 && !r.body.booking.completed[d1], 'completion undone');

    console.log('\n[11] every owner endpoint refuses the helper');
    const ownerChecks = [
      ['GET /api/clients',  clientsHandler,  { cookie: h1c }],
      ['GET /api/invoices', invoicesHandler, { cookie: h1c }],
      ['GET /api/ivy',      ivyHandler,      { cookie: h1c }],
      ['GET /api/finance',  financeHandler,  { cookie: h1c }],
      ['GET /api/staff',    staffIndex,      { cookie: h1c }],
      ['POST /api/calendar/bookings/complete', ownerComplete, { method: 'POST', cookie: h1c, body: { id: b1.id, occurrenceDate: d1 } }],
    ];
    for (const [label, handler, opts] of ownerChecks) {
      // eslint-disable-next-line no-await-in-loop
      r = await call(handler, opts);
      assert(r.statusCode === 403 && r.body?.error === 'helper-only', `${label} → 403 helper-only (got ${r.statusCode} ${JSON.stringify(r.body).slice(0, 80)})`);
    }
    const stillNoWs = await sql`SELECT id FROM workspaces WHERE owner_id = ${h1.id}`;
    assert(stillNoWs.rows.length === 0, 'owner endpoints never minted a workspace for the helper');

    console.log('\n[12] helper of B sees nothing of A');
    await call(staffInvite, { method: 'POST', cookie: B.cookie, query: { id: sB } });
    const tokB = tokenFromEmail(lastEmail());
    r = await call(helperAccept, { method: 'POST', body: { token: tokB, name: 'Cedar Helper', password: NEW_PW, ...terms } });
    const h4 = (await sql`SELECT id FROM users WHERE email = ${em('h4')}`).rows[0];
    userIds.push(h4.id);
    const h4c = cookieFor(h4.id);
    r = await call(helperSchedule, { cookie: h4c });
    assert(r.statusCode === 200 && r.body.workspaceId === B.workspaceId && r.body.bookings.length === 1, 'B helper sees their one B booking');
    r = await call(helperSchedule, { cookie: h4c, query: { workspaceId: A.workspaceId } });
    assert(r.statusCode === 403, 'B helper asking for A → 403');
    r = await call(helperComplete, { method: 'POST', cookie: h4c, query: { id: b1.id }, body: { occurrenceDate: d1, workspaceId: B.workspaceId } });
    assert(r.statusCode === 404, "B helper completing A's booking → 404");
    r = await call(helperClients, { cookie: h4c });
    assert(r.body.clients.every((c) => c.id === cB), 'B helper sees only B clients');

    console.log('\n[13] revoke cuts access immediately; /api/me keeps the link as revoked');
    r = await call(staffRevoke, { method: 'POST', cookie: A.cookie, query: { id: s1 } });
    assert(r.statusCode === 200 && r.body.staff.helper.status === 'revoked', 'revoke → status revoked');
    row = await staffRow(s1);
    assert(row.user_id === null && !!row.revoked_at && row.revoked_user_id === h1.id, 'user_id cleared, revoked_at + revoked_user_id stamped');
    r = await call(helperSchedule, { cookie: h1c });
    assert(r.statusCode === 403 && r.body.error === 'revoked' && r.body.message === "Looks like you're no longer part of this team on Ivy.", 'next helper request → 403 revoked with the friendly line');
    r = await call(helperMe, { cookie: h1c });
    assert(r.statusCode === 403 && r.body.error === 'revoked', '/api/helper/me → 403 revoked');
    r = await call(meHandler, { cookie: h1c });
    assert(r.body.isHelper === false && r.body.helps.length === 1 && r.body.helps[0].status === 'revoked' && r.body.helps[0].businessName === 'Maple Studio', '/api/me: isHelper false, helps[0].status revoked');
    r = await call(staffIndex, { cookie: A.cookie });
    assert(r.body.helperSeats.used === 1, 'seat freed by revoke');
    r = await call(staffInvite, { method: 'POST', cookie: A.cookie, query: { id: s1 } });
    const tok1b = tokenFromEmail(lastEmail());
    r = await call(helperAccept, { method: 'POST', cookie: h1c, body: { token: tok1b } });
    assert(r.statusCode === 200 && r.body.created === false, 'invite again → the same account re-attaches');
    row = await staffRow(s1);
    assert(row.user_id === h1.id && row.revoked_at === null && row.revoked_user_id === null, 'revoked marks cleared on re-accept');
    r = await call(helperSchedule, { cookie: h1c });
    assert(r.statusCode === 200, 'access restored');

    console.log('\n[14] the Uh-oh screen copy (frontend source)');
    const goneSrc = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'features', 'helper', 'HelperGone.jsx'), 'utf8');
    for (const line of [
      "Looks like you're no longer part of this team on Ivy.",
      'Looks like this team is paused on Ivy right now.',
      'Run your own business? Ivy was built for you.',
      'Ivy is the business platform for businesses of one.',
      'Free for 14 days, then $8.99 a week. Cancel anytime.',
      'Start your 14-day free trial',
      'Go to your business', 'Go to your client portal', 'Log out',
    ]) assert(goneSrc.includes(line), `copy present: "${line.slice(0, 50)}"`);
    assert(!goneSrc.includes('\u2014'), 'no em dashes in the screen');
    assert(!/businessName/.test(goneSrc), 'screen never shows the business name');

    console.log('\n[15] lapse: owner subscription ends → helper access pauses (402)');
    await sql`UPDATE workspaces SET subscription_status = 'cancelled', subscription_period_end = NOW() - INTERVAL '1 day' WHERE id = ${B.workspaceId}`;
    evictWorkspaceGateCache(B.workspaceId);
    r = await call(helperMe, { cookie: h4c });
    assert(r.statusCode === 402 && r.body.error === 'business-paused' && /paused on Ivy/.test(r.body.message), `helper/me → 402 business-paused ("${r.body.message}")`);
    r = await call(helperSchedule, { cookie: h4c });
    assert(r.statusCode === 402, 'schedule → 402 too');
    r = await call(meHandler, { cookie: h4c });
    assert(r.body.helps[0].active === false && r.body.helps[0].status === 'active', '/api/me: still a helper, active: false');
    await sql`UPDATE workspaces SET subscription_status = 'active', subscription_period_end = NOW() + INTERVAL '30 days' WHERE id = ${B.workspaceId}`;
    evictWorkspaceGateCache(B.workspaceId);
    r = await call(helperMe, { cookie: h4c });
    assert(r.statusCode === 200, 'reactivated → helper back in');

    console.log('\n[16] "Run your own business": explicit start, then owner endpoints open up');
    r = await call(helperStart, { method: 'POST', cookie: h4c });
    assert(r.statusCode === 201 && !!r.body.workspaceId, 'start-business creates a workspace');
    r = await call(helperStart, { method: 'POST', cookie: h4c });
    assert(r.statusCode === 200 && r.body.created === false, 'idempotent');
    r = await call(meHandler, { cookie: h4c });
    assert(r.body.isOwner === true && r.body.isHelper === true, 'now both owner and helper → switcher case');
    r = await call(staffIndex, { cookie: h4c });
    assert(r.statusCode === 200 && r.body.staff.length === 0, 'their own (empty) staff list, not B\'s');

    console.log('\n[17] rate limit on the public accept endpoint');
    let last = 0;
    for (let i = 0; i < 11; i++) {
      // eslint-disable-next-line no-await-in-loop
      r = await call(helperAccept, { method: 'POST', ip: '198.51.100.77', body: { token: 'not-a-real-token-at-all-0000000000' } });
      last = r.statusCode;
    }
    assert(last === 429, `11th attempt from one IP → 429 (got ${last})`);


    console.log('\n[17b] per-helper permissions (schedule / clients / messages)');
    const asA = { 'x-helper-workspace': A.workspaceId };
    const asB = { 'x-helper-workspace': B.workspaceId };
    const expectPerm = (r2, name, label) => assert(r2.statusCode === 403 && r2.body?.error === 'permission' && r2.body?.permission === name,
      `${label} → 403 permission "${name}" (got ${r2.statusCode} ${JSON.stringify(r2.body).slice(0, 80)})`);
    const expectOwnerOnly = (r2, label) => assert(r2.statusCode === 403 && r2.body?.error === 'helper-only',
      `${label} → 403 helper-only even in helper mode (got ${r2.statusCode} ${JSON.stringify(r2.body).slice(0, 80)})`);
    // All off by default → each matching endpoint refuses with the permission name.
    expectPerm(await call(calendarIndex, { cookie: h1c, headers: asA }), 'schedule', 'GET /api/calendar');
    expectPerm(await call(bookingsCreate, { method: 'POST', cookie: h1c, headers: asA, body: { date: '2030-01-01', startMin: 600, endMin: 660, clientName: 'X', clientEmail: 'x@example.com' } }), 'schedule', 'POST /api/calendar/bookings');
    expectPerm(await call(bookingById, { method: 'PATCH', cookie: h1c, headers: asA, query: { id: b2.id }, body: { notes: 'hi' } }), 'schedule', 'PATCH /api/calendar/bookings/:id');
    expectPerm(await call(staffIndex, { cookie: h1c, headers: asA }), 'schedule', 'GET /api/staff (assignment list)');
    expectPerm(await call(clientsHandler, { cookie: h1c, headers: asA }), 'clients', 'GET /api/clients');
    expectPerm(await call(clientsHandler, { method: 'POST', cookie: h1c, headers: asA, body: { name: 'New' } }), 'clients', 'POST /api/clients');
    expectPerm(await call(clientById, { method: 'PATCH', cookie: h1c, headers: asA, query: { id: c1 }, body: { notes: 'x' } }), 'clients', 'PATCH /api/clients/:id');
    expectPerm(await call(messagesIndex, { cookie: h1c, headers: asA }), 'messages', 'GET /api/messages');
    expectPerm(await call(messagesIndex, { method: 'POST', cookie: h1c, headers: asA, body: { clientId: c1 } }), 'messages', 'POST /api/messages');
    // Owner-only surfaces stay closed in helper mode no matter what.
    expectOwnerOnly(await call(invoicesHandler, { cookie: h1c, headers: asA }), 'GET /api/invoices');
    expectOwnerOnly(await call(financeHandler, { cookie: h1c, headers: asA }), 'GET /api/finance');
    expectOwnerOnly(await call(calendarIndex, { method: 'PATCH', cookie: h1c, headers: asA, body: { bizName: 'Hijack' } }), 'PATCH /api/calendar (settings)');
    expectOwnerOnly(await call(staffIndex, { method: 'POST', cookie: h1c, headers: asA, body: { name: 'Sneaky' } }), 'POST /api/staff');
    r = await call(ivyHandler, { cookie: h1c, headers: asA });
    assert(r.statusCode === 403, `GET /api/ivy in helper mode → 403 (${r.statusCode})`);

    // schedule ON (owner edits, no re-invite) → the whole calendar of A, scoped to A.
    r = await call(staffById, { method: 'PATCH', cookie: A.cookie, query: { id: s1 }, body: { permissions: { schedule: true } } });
    assert(r.statusCode === 200 && r.body.staff.permissions.schedule === true && r.body.staff.helper.permissions.schedule === true, 'owner PATCH permissions.schedule = true');
    r = await call(meHandler, { cookie: h1c });
    assert(r.body.helps[0].permissions.schedule === true && r.body.helps[0].permissions.clients === false, '/api/me reflects the change immediately');
    r = await call(calendarIndex, { cookie: h1c, headers: asA });
    assert(r.statusCode === 200, `GET /api/calendar with schedule → 200 (${r.statusCode})`);
    const calIds = (r.body.calendar?.bookings || []).map((b) => b.id);
    assert(calIds.includes(b1.id) && calIds.includes(b2.id), 'sees other staff members\' bookings too');
    const bBookings = (await sql`SELECT id FROM bookings WHERE workspace_id = ${B.workspaceId}`).rows.map((x) => x.id);
    assert(bBookings.length > 0 && !bBookings.some((id) => calIds.includes(id)), 'nothing from workspace B in the calendar');
    r = await call(staffIndex, { cookie: h1c, headers: asA });
    assert(r.statusCode === 200 && r.body.staff.some((x) => x.id === s4), 'GET /api/staff lists A\'s staff for assignment');
    r = await call(bookingsCreate, { method: 'POST', cookie: h1c, headers: asA, body: {
      date: '2030-03-03', startMin: 600, endMin: 660, clientId: c3, clientName: 'Client Three', clientEmail: 'three@example.com',
      staffId: s4, skipConflictCheck: true,
    } });
    assert(r.statusCode === 201 && r.body.booking?.staffId === s4, `helper adds a booking assigned to another staff member (${r.statusCode})`);
    const bNew = r.body.booking.id;
    r = await call(bookingById, { method: 'PATCH', cookie: h1c, headers: asA, query: { id: bNew }, body: { staffId: s1 } });
    assert(r.statusCode === 200 && r.body.booking?.staffId === s1, `helper reassigns it (${r.statusCode} ${JSON.stringify(r.body).slice(0, 80)})`);
    r = await call(bookingById, { method: 'PATCH', cookie: h1c, headers: asA, query: { id: bNew }, body: { rescheduleTo: { date: '2030-03-04', startMin: 660, endMin: 720 } } });
    assert(r.statusCode === 200 && r.body.booking?.date === '2030-03-04' && r.body.booking?.startMin === 660, `helper moves it (${r.statusCode} ${JSON.stringify(r.body).slice(0, 80)})`);
    r = await call(ownerNoShow, { method: 'POST', cookie: h1c, headers: asA, body: { id: bNew, chargeFee: true } });
    assert(r.statusCode === 200 && r.body.charged === false, 'owner no-show endpoint in helper mode never charges');
    await call(ownerNoShow, { method: 'DELETE', cookie: h1c, headers: asA, body: { id: bNew } });
    r = await call(bookingById, { method: 'DELETE', cookie: h1c, headers: asA, query: { id: bNew } });
    assert(r.statusCode === 204 || r.statusCode === 200, `helper cancels the booking (${r.statusCode})`);
    const cancelledRow = (await sql`SELECT cancelled_at FROM bookings WHERE id = ${bNew}`).rows[0];
    assert(!!cancelledRow?.cancelled_at, 'booking cancelled in the DB');
    // schedule alone does not open clients editing or messages.
    expectPerm(await call(clientsHandler, { method: 'POST', cookie: h1c, headers: asA, body: { name: 'New' } }), 'clients', 'POST /api/clients with schedule only');
    expectPerm(await call(messagesIndex, { cookie: h1c, headers: asA }), 'messages', 'GET /api/messages with schedule only');

    // clients ON → full list, add, edit notes, delete; all scoped to A.
    await call(staffById, { method: 'PATCH', cookie: A.cookie, query: { id: s1 }, body: { permissions: { schedule: false, clients: true } } });
    r = await call(clientsHandler, { cookie: h1c, headers: asA });
    const listIds = (r.body.clients || []).map((c) => c.id);
    assert(r.statusCode === 200 && listIds.includes(c1) && listIds.includes(c3) && !listIds.includes(cB), 'GET /api/clients: every A client, no B client');
    r = await call(clientsHandler, { method: 'POST', cookie: h1c, headers: asA, body: { name: 'Added By Helper', email: 'added@example.com' } });
    assert(r.statusCode === 201 && r.body.client?.id, `helper adds a client (${r.statusCode})`);
    const cNew = r.body.client.id;
    const cNewRow = (await sql`SELECT workspace_id FROM clients WHERE id = ${cNew}`).rows[0];
    assert(cNewRow.workspace_id === A.workspaceId, 'new client lands in workspace A');
    r = await call(clientById, { method: 'PATCH', cookie: h1c, headers: asA, query: { id: cNew }, body: { notes: 'Prefers mornings' } });
    assert(r.statusCode === 200 && r.body.client?.notes === 'Prefers mornings', 'helper writes client notes');
    r = await call(clientById, { method: 'PATCH', cookie: h1c, headers: asA, query: { id: cB }, body: { notes: 'nope' } });
    assert(r.statusCode === 404, "B's client is not found from A");
    r = await call(clientById, { method: 'DELETE', cookie: h1c, headers: asA, query: { id: cNew } });
    assert(r.statusCode === 204 || r.statusCode === 200, `helper deletes the client (${r.statusCode})`);
    expectPerm(await call(calendarIndex, { cookie: h1c, headers: asA }), 'schedule', 'GET /api/calendar with clients only');

    // messages ON (schedule OFF) → only threads for clients they are booked with.
    await call(staffById, { method: 'PATCH', cookie: A.cookie, query: { id: s1 }, body: { permissions: { messages: true } } });
    let tr = await call(messagesIndex, { method: 'POST', cookie: A.cookie, body: { clientId: c1 } });
    const t1 = tr.body.thread.id; // c1 is booked with s1
    tr = await call(messagesIndex, { method: 'POST', cookie: A.cookie, body: { clientId: c3 } });
    const t3 = tr.body.thread.id; // c3 is not
    r = await call(messagesIndex, { cookie: h1c, headers: asA });
    const tIds = (r.body.threads || []).map((t) => t.id);
    assert(r.statusCode === 200 && tIds.includes(t1) && !tIds.includes(t3), 'thread list limited to clients they are booked with');
    r = await call(messageThread, { cookie: h1c, headers: asA, query: { id: t3 } });
    assert(r.statusCode === 404, 'another client\'s thread is not found');
    expectPerm(await call(messagesIndex, { method: 'POST', cookie: h1c, headers: asA, body: { clientId: c3 } }), 'schedule', 'starting a thread with a client they are not booked with');
    r = await call(messageThread, { method: 'POST', cookie: h1c, headers: asA, query: { id: t1 }, body: { text: 'Running five minutes late' } });
    assert(r.statusCode === 201 || r.statusCode === 200, `helper sends in the booked client's thread (${r.statusCode} ${JSON.stringify(r.body).slice(0, 80)})`);
    const msgRow = (await sql`SELECT sender, meta FROM messages WHERE thread_id = ${t1} ORDER BY created_at DESC LIMIT 1`).rows[0];
    assert(msgRow.sender === 'biz' && msgRow.meta?.sentBy === 'helper' && msgRow.meta?.helperStaffId === s1 && msgRow.meta?.helperUserId === h1.id,
      'sent as the business, attributed to the helper in meta');
    // messages + schedule → every client.
    await call(staffById, { method: 'PATCH', cookie: A.cookie, query: { id: s1 }, body: { permissions: { messages: true, schedule: true } } });
    r = await call(messagesIndex, { cookie: h1c, headers: asA });
    assert((r.body.threads || []).some((t) => t.id === t3), 'with schedule too, every client\'s thread is listed');
    r = await call(messagesIndex, { method: 'POST', cookie: h1c, headers: asA, body: { clientId: c3 } });
    assert(r.statusCode === 201 || r.statusCode === 200, 'and they can start a thread with any client');

    // Every permission on → still nothing of B, and B's helper gets nothing of A.
    await call(staffById, { method: 'PATCH', cookie: A.cookie, query: { id: s1 }, body: { permissions: { messages: true, schedule: true, clients: true } } });
    for (const [label, handler, opts] of [
      ['GET /api/calendar as B', calendarIndex, { cookie: h1c, headers: asB }],
      ['GET /api/clients as B', clientsHandler, { cookie: h1c, headers: asB }],
      ['GET /api/messages as B', messagesIndex, { cookie: h1c, headers: asB }],
    ]) {
      // eslint-disable-next-line no-await-in-loop
      r = await call(handler, opts);
      assert(r.statusCode === 403 && r.body?.error === 'not-a-helper', `${label} → 403 not-a-helper (${r.statusCode})`);
    }
    r = await call(calendarIndex, { cookie: h4c, headers: asA });
    assert(r.statusCode === 403 && r.body?.error === 'not-a-helper', "B's helper asking for A's calendar → 403");
    r = await call(invoicesHandler, { cookie: h1c, headers: asA });
    assert(r.statusCode === 403 && r.body?.error === 'helper-only', 'all three permissions still never open invoices');
    // Back to none: takes effect at once.
    await call(staffById, { method: 'PATCH', cookie: A.cookie, query: { id: s1 }, body: { permissions: {} } });
    expectPerm(await call(calendarIndex, { cookie: h1c, headers: asA }), 'schedule', 'permissions cleared → calendar closed again');

    // Invite email lists what they will be able to do ("Add helper" on B, which has a free seat).
    r = await call(staffIndex, { method: 'POST', cookie: B.cookie, body: { name: 'Listed Abilities', email: em('h7'), invite: true, permissions: { schedule: true, messages: true } } });
    assert(r.statusCode === 201 && r.body.staff.permissions.schedule === true && r.body.staff.permissions.clients === false, `Add helper stores the chosen permissions (${r.statusCode})`);
    const inviteHtml = lastEmail().html || '';
    assert(/See the sessions assigned to you/.test(inviteHtml), 'email lists the base ability');
    assert(/See the whole calendar/.test(inviteHtml) && /Message clients/.test(inviteHtml), 'email lists the granted abilities');
    assert(!/full client list/.test(inviteHtml), 'email does not list an ability that was not granted');
    assert(Array.isArray(r.body.invite?.abilities) && r.body.invite.abilities.length === 3, 'response echoes the abilities');
    await call(staffInvite, { method: 'DELETE', cookie: B.cookie, query: { id: r.body.staff.id } });

    console.log('\n[17c] helpers never meet a paywall');
    const src = (rel) => readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', ...rel.split('/')), 'utf8');
    const shellSrc = src('src/features/helper/HelperShell.jsx');
    for (const word of ['Paywall', 'SubscriptionBanner', 'Walkthrough', 'start-trial', 'previewPaywall', 'TrialPriming', 'SetupReplay']) {
      assert(!shellSrc.includes(word), `HelperShell.jsx never mentions ${word}`);
    }
    const appSrc = src('src/App.jsx');
    assert(/<Route element=\{<RequireAuth><HelperShell \/><\/RequireAuth>\}>/.test(appSrc), 'helper routes mount HelperShell directly, not AppShell (where the Paywall lives)');
    const appShellSrc = src('src/components/layout/AppShell.jsx');
    assert(/ctx\?\.isOwner && !ctx\?\.subscription\?\.isActive/.test(appShellSrc), 'AppShell paywall is gated on isOwner (false for a helper)');
    const landingSrc = src('src/lib/landing.js');
    assert(/return 'helper'/.test(landingSrc), 'landing sends helper-only accounts to /helper, never into the business shell');
    const roleRouterSrc = src('src/features/auth/RoleRouter.jsx');
    assert(/effective === 'helper'/.test(roleRouterSrc), 'RoleRouter bounces a helper who types a business URL back to /helper');
    const paywallImporters = ['src/components/layout/AppShell.jsx', 'src/features/helper/HelperShell.jsx', 'src/features/helper/HelperSchedule.jsx', 'src/features/helper/HelperAccount.jsx', 'src/features/helper/HelperGone.jsx']
      .filter((f) => /billing\/Paywall|SubscriptionBanner/.test(src(f)));
    assert(paywallImporters.length === 1 && paywallImporters[0] === 'src/components/layout/AppShell.jsx', 'only AppShell imports the Paywall / SubscriptionBanner');
    r = await call(helperMe, { cookie: h1c });
    assert(r.statusCode === 200 && !('subscription' in r.body) && !('paywall' in r.body), '/api/helper/me carries no subscription state');
    // A helper who also owns a business keeps the owner rules for THAT business only.
    r = await call(meHandler, { cookie: h4c });
    assert(r.body.isOwner === true && r.body.subscription && r.body.subscription.isActive === false && r.body.isHelper === true,
      'owner+helper (h4): their own workspace is paywalled as usual, helper link intact');
    r = await call(helperMe, { cookie: h4c });
    assert(r.statusCode === 200, 'and their helper access at B is unaffected by their own paywall');

    console.log('\n[18] owner purge leaves the helper\'s own login intact');
    // Data-retention purge sweeps every workspace-keyed table (staff rows
    // and invites included) ...
    const purged = await purgeWorkspaceData(A.workspaceId);
    assert(purged.staff_members >= 1, `purge swept staff_members (${JSON.stringify(purged.staff_members)})`);
    const h1AfterPurge = await sql`SELECT id, deleted_at FROM users WHERE id = ${h1.id}`;
    assert(h1AfterPurge.rows.length === 1 && h1AfterPurge.rows[0].deleted_at === null, 'helper users row untouched by the purge');
    // ... and the owner's hard delete (what db-prune does 30 days after a
    // soft delete) cascades the workspace itself.
    await sql`DELETE FROM users WHERE id = ${A.id}`;
    const h1Row = await sql`SELECT id, deleted_at FROM users WHERE id = ${h1.id}`;
    assert(h1Row.rows.length === 1 && h1Row.rows[0].deleted_at === null, 'helper users row still there after the owner is gone');
    const gone = await sql`SELECT id FROM staff_members WHERE workspace_id = ${A.workspaceId}`;
    assert(gone.rows.length === 0, 'workspace-keyed staff rows went with the workspace');
    r = await call(meHandler, { cookie: h1c });
    assert(r.statusCode === 200 && r.body.helps.length === 0 && r.body.isHelper === false, 'helper can still sign in; helps now empty');

    console.log('\n[19] helper deletes their account → only detached');
    await sql`UPDATE workspaces SET owner_id = ${h4.id} WHERE owner_id = ${h4.id}`; // no-op, keeps the row referenced
    r = await call(accountDelete, { method: 'POST', cookie: h4c, body: { confirmEmail: em('h4') } });
    assert(r.statusCode === 200, `account delete 200 (${r.statusCode}: ${JSON.stringify(r.body).slice(0, 80)})`);
    row = await staffRow(sB);
    assert(row && row.user_id === null && !!row.revoked_at, "B's staff record survives, login detached");
    const h4Row = (await sql`SELECT deleted_at FROM users WHERE id = ${h4.id}`).rows[0];
    assert(!!h4Row.deleted_at, 'their own account soft-deleted as asked');
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  } finally {
    globalThis.fetch = realFetch;
    await sql`DELETE FROM rate_limits WHERE key LIKE 'helper-%'`.catch(() => {});
    for (const id of userIds.filter(Boolean)) {
      await sql`DELETE FROM workspaces WHERE owner_id = ${id}`.catch(() => {});
      await sql`DELETE FROM users WHERE id = ${id}`.catch(() => {});
    }
    await sql`DELETE FROM users WHERE email LIKE ${'helpers-%-' + STAMP + '@example.com'}`.catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
}
run();
