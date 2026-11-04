// Client portal 1.0.5: new /api/me fields, profile photo upload scope,
// "download my data", and cross-client isolation for all of them.
//
//   • /api/me memberships gain bookingSlug + logoUrl; every old field stays
//   • /api/me/bookings: only my bookings across both my businesses, never
//     another client's, never bookings.private_notes or hidden session notes;
//     new fields cardOnFile / fromPackage / locationLabel / businessAddress
//   • /api/me/invoices: amountDue / paidAmount, only mine, no drafts
//   • /api/me/packages + /api/me/programs: clientId is always one of mine
//   • /api/me/photo-token: only signs user/<myId>/..., auth required
//   • /api/me/profile PATCH photoUrl: own blob folder or plain https only
//   • /api/me/export: client-safe columns only, no workspace created,
//     emailed copy is rate limited; the owner account export's
//     client_portal section uses the same safe builder
//
// Run: node --import ./tests/bootstrap.mjs ./tests/client-portal-v105.test.mjs
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import { assertUploadPathname, assertUserUploadPathname, blobPathnameForUser, UploadScopeError } from '../api/_lib/blobScope.js';
import { buildAccountExport } from '../api/_lib/accountExport.js';
import meHandler from '../api/me/index.js';
import bookingsHandler from '../api/me/bookings.js';
import invoicesHandler from '../api/me/invoices/index.js';
import packagesHandler from '../api/me/packages.js';
import programsHandler from '../api/me/programs/index.js';
import profileHandler from '../api/me/profile.js';
import photoTokenHandler from '../api/me/photo-token.js';
import exportHandler from '../api/me/export.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

// Capture outbound email instead of sending it.
const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).includes('resend.com')) {
    try { sent.push(JSON.parse(init?.body || '{}')); } catch { sent.push({}); }
    return { ok: true, status: 200, json: async () => ({ id: 'captured' }), text: async () => '{}' };
  }
  return realFetch(url, init);
};

function mockRes() {
  return {
    statusCode: 200, headers: {}, body: undefined, raw: '',
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(o) { this.body = o; return this; },
    write(s) { this.raw += s; return true; },
    end(s) {
      if (s !== undefined) { this.raw += s; try { this.body = JSON.parse(this.raw); } catch { this.body = this.raw; } }
      return this;
    },
    writeHead(c) { this.statusCode = c; return this; },
  };
}
let ipN = 0;
function req({ method = 'GET', body, query = {}, cookie } = {}) {
  ipN++;
  return {
    method, url: '/api/test', query, body: body || {},
    headers: {
      'content-type': 'application/json', origin: 'http://localhost:3000', host: 'localhost:3000',
      'x-forwarded-for': `203.0.113.${(ipN % 200) + 20}`, ...(cookie ? { cookie } : {}),
    },
  };
}
const call = async (h, o) => { const r = mockRes(); await h(req(o), r); return r; };

const STAMP = Date.now();
const userIds = [];
async function mkUser(tag, { verified = true } = {}) {
  const email = `cp105-${tag}-${STAMP}@example.com`;
  const u = await sql`INSERT INTO users (email, password_hash, name, email_verified_at)
    VALUES (${email}, 'x', ${'User ' + tag}, ${verified ? new Date().toISOString() : null}) RETURNING id`;
  userIds.push(u.rows[0].id);
  return { id: u.rows[0].id, email, cookie: `ivy_session=${signSession(u.rows[0].id)}` };
}
async function mkBusiness(tag, owner) {
  const w = await sql`INSERT INTO workspaces (owner_id, subscription_status, subscription_period_end, onboarded_at)
    VALUES (${owner.id}, 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`;
  const wid = w.rows[0].id;
  await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug, address_label, brand_logo_url)
    VALUES (${wid}, ${'Biz ' + tag}, ${`cp105-${tag}-${STAMP}`}, ${'1 Main St, ' + tag}, ${'https://abc.public.blob.vercel-storage.com/ws/' + wid + '/logo.png'})`;
  const s = await sql`INSERT INTO services (workspace_id, name, duration_minutes, price, location_label, cancellation_fee_amount, cancellation_window_hours)
    VALUES (${wid}, ${'Cut ' + tag}, 60, 50, ${'Suite ' + tag}, 15, 24) RETURNING id`;
  return { wid, serviceId: s.rows[0].id };
}
async function mkClient(biz, user, name) {
  const c = await sql`INSERT INTO clients (workspace_id, name, email, user_id, stage)
    VALUES (${biz.wid}, ${name}, ${user.email}, ${user.id}, 'active') RETURNING id`;
  return c.rows[0].id;
}
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

async function run() {
  await ensureSchemaApplied();
  process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_abc123store_testsecretvalue0000000000';

  const ownerA = await mkUser('ownerA');
  const ownerB = await mkUser('ownerB');
  const me = await mkUser('me');          // client of both businesses
  const other = await mkUser('other');    // another client at business A
  const bizA = await mkBusiness('A', ownerA);
  const bizB = await mkBusiness('B', ownerB);
  const myA = await mkClient(bizA, me, 'Me At A');
  const myB = await mkClient(bizB, me, 'Me At B');
  const otherA = await mkClient(bizA, other, 'Other At A');
  await sql`UPDATE clients SET stripe_customer_id = 'cus_x', payment_method_id = 'pm_x' WHERE id = ${myA}`;

  const pkgMine = await sql`INSERT INTO client_packages (workspace_id, client_id, name, credits_total, credits_remaining, status)
    VALUES (${bizA.wid}, ${myA}, 'Five pack', 5, 3, 'active') RETURNING id`;
  await sql`INSERT INTO client_packages (workspace_id, client_id, name, credits_total, credits_remaining, status)
    VALUES (${bizA.wid}, ${otherA}, 'OTHER PACK', 5, 5, 'active')`;

  const mine1 = await sql`INSERT INTO bookings (workspace_id, client_id, service_id, client_name, date, start_min, end_min, notes, private_notes, client_package_id, completion_log)
    VALUES (${bizA.wid}, ${myA}, ${bizA.serviceId}, 'Me At A', ${day(3)}, 600, 660, 'bring water', 'OWNER SECRET A', ${pkgMine.rows[0].id}, '{}'::jsonb) RETURNING id`;
  await sql`INSERT INTO bookings (workspace_id, client_id, service_id, client_name, date, start_min, end_min, private_notes, completion_log)
    VALUES (${bizB.wid}, ${myB}, ${bizB.serviceId}, 'Me At B', ${day(-5)}, 540, 600, 'OWNER SECRET B',
      ${JSON.stringify({ [day(-5)]: { completedAt: new Date().toISOString(), notes: 'HIDDEN SESSION NOTE', visibleToClient: false } })}::jsonb)`;
  await sql`INSERT INTO bookings (workspace_id, client_id, service_id, client_name, date, start_min, end_min, notes)
    VALUES (${bizA.wid}, ${otherA}, ${bizA.serviceId}, 'Other At A', ${day(4)}, 600, 660, 'OTHER CLIENT NOTE')`;

  await sql`INSERT INTO invoices (workspace_id, client_id, number, status, issue_date, due_date, items, total, paid_amount, currency)
    VALUES (${bizA.wid}, ${myA}, ${'CP-MINE-' + STAMP}, 'sent', ${day(-2)}, ${day(5)}, '[{"description":"Cut","quantity":1,"rate":100}]'::jsonb, 100, 40, 'USD')`;
  await sql`INSERT INTO invoices (workspace_id, client_id, number, status, issue_date, items, total, currency)
    VALUES (${bizA.wid}, ${myA}, ${'CP-DRAFT-' + STAMP}, 'draft', ${day(-1)}, '[]'::jsonb, 10, 'USD')`;
  await sql`INSERT INTO invoices (workspace_id, client_id, number, status, issue_date, items, total, currency)
    VALUES (${bizA.wid}, ${otherA}, ${'CP-OTHER-' + STAMP}, 'sent', ${day(-1)}, '[]'::jsonb, 999, 'USD')`;

  const prog = await sql`INSERT INTO programs (workspace_id, title, status) VALUES (${bizB.wid}, 'Reset plan', 'published') RETURNING id`;
  await sql`INSERT INTO program_enrollments (program_id, workspace_id, client_id, status) VALUES (${prog.rows[0].id}, ${bizB.wid}, ${myB}, 'active')`;
  const progOther = await sql`INSERT INTO programs (workspace_id, title, status) VALUES (${bizA.wid}, 'OTHER PROGRAM', 'published') RETURNING id`;
  await sql`INSERT INTO program_enrollments (program_id, workspace_id, client_id, status) VALUES (${progOther.rows[0].id}, ${bizA.wid}, ${otherA}, 'active')`;

  console.log('\n[1] /api/me keeps old membership fields and adds bookingSlug + logoUrl');
  let r = await call(meHandler, { cookie: me.cookie });
  const ms = r.body?.memberships || [];
  assert(r.statusCode === 200 && ms.length === 2, `two businesses (${r.statusCode}, ${ms.length})`);
  const mA = ms.find((m) => m.clientId === myA);
  for (const k of ['clientId', 'workspaceId', 'clientName', 'clientEmail', 'businessName', 'archived']) {
    assert(mA && k in mA, `membership still has ${k}`);
  }
  assert(mA?.bookingSlug === `cp105-A-${STAMP}`, 'bookingSlug added');
  assert(/logo\.png$/.test(mA?.logoUrl || ''), 'logoUrl added');
  assert(!ms.some((m) => m.clientId === otherA), "another client's row never appears");
  for (const k of ['unreadMessages', 'upcomingBookings', 'openInvoices', 'pendingDocs', 'pendingReviews']) {
    assert(r.body?.summary && k in r.body.summary, `summary still has ${k}`);
  }

  console.log('\n[2] /api/me/bookings: mine only, no private fields, new fields present');
  r = await call(bookingsHandler, { cookie: me.cookie });
  const all = [...(r.body?.upcoming || []), ...(r.body?.past || []), ...(r.body?.cancelled || [])];
  const raw = JSON.stringify(r.body);
  assert(r.statusCode === 200 && all.length === 2, `exactly my 2 bookings across both businesses (got ${all.length})`);
  assert(!raw.includes('OTHER CLIENT NOTE'), "another client's booking is not visible");
  assert(!raw.includes('OWNER SECRET'), 'bookings.private_notes never sent');
  assert(!/private_?notes/i.test(raw), 'no private notes key at all');
  assert(!raw.includes('HIDDEN SESSION NOTE'), 'session notes hidden from the client stay hidden');
  const up = (r.body.upcoming || [])[0];
  for (const k of ['id', 'date', 'startMin', 'endMin', 'notes', 'serviceId', 'serviceName', 'price', 'cancellationFeeAmount',
    'cancellationWindowHours', 'startEpochMs', 'videoRoomUrl', 'locationAddress', 'businessName', 'archived', 'bizSlug',
    'clientId', 'payment', 'calendar']) {
    assert(up && k in up, `booking still has ${k}`);
  }
  assert(up?.cardOnFile === true, 'cardOnFile true where I saved a card');
  assert(up?.fromPackage === true, 'fromPackage true for a package booking');
  assert(up?.locationLabel === 'Suite A', 'locationLabel from the service');
  assert(up?.businessAddress === '1 Main St, A', 'businessAddress for in-person');
  const pastB = (r.body.past || [])[0];
  assert(pastB && pastB.cardOnFile === false && pastB.fromPackage === false, 'flags false elsewhere');

  r = await call(bookingsHandler, { cookie: other.cookie });
  const rawOther = JSON.stringify(r.body);
  assert(!rawOther.includes('bring water') && !rawOther.includes(myA), "the other client can't see my booking");

  console.log('\n[3] /api/me/invoices: amountDue/paidAmount, mine only, no drafts');
  r = await call(invoicesHandler, { cookie: me.cookie });
  const invs = r.body?.invoices || [];
  assert(invs.length === 1 && invs[0].number === 'CP-MINE-' + STAMP, `only my sent invoice (got ${invs.map((i) => i.number).join(',')})`);
  assert(invs[0]?.amountDue === 60 && invs[0]?.paidAmount === 40, `amountDue 60, paidAmount 40 (${invs[0]?.amountDue}/${invs[0]?.paidAmount})`);
  for (const k of ['joinedAt', 'nextBooking', 'lastBookingBizSlug', 'activePackage', 'activeMembership', 'sessionsThisYear']) {
    assert(k in (r.body || {}), `invoices response still has ${k}`);
  }

  console.log('\n[4] /api/me/packages + /api/me/programs: mine only, matched to a business card without ids');
  r = await call(packagesHandler, { cookie: me.cookie });
  const pk = r.body?.packages || [];
  assert(pk.length === 1 && pk[0].name === 'Five pack' && pk[0].bookingSlug === mA?.bookingSlug, 'my package, tied to its business by booking handle');
  assert(pk[0]?.clientId === undefined, 'no internal client id in the package payload');
  assert(!JSON.stringify(r.body).includes('OTHER PACK'), "another client's package not visible");
  r = await call(programsHandler, { cookie: me.cookie });
  const pg = r.body?.programs || [];
  assert(pg.length === 1 && pg[0].businessName === 'Biz B', 'my program, from business B');
  assert(!JSON.stringify(r.body).includes('OTHER PROGRAM'), "another client's program not visible");

  console.log('\n[5] blob scope: user folder');
  assert(assertUserUploadPathname(`user/${me.id}/photo.jpg`, me.id) === `user/${me.id}/photo.jpg`, 'own folder ok');
  const throws = (fn) => { try { fn(); return false; } catch (e) { return e instanceof UploadScopeError; } };
  assert(throws(() => assertUserUploadPathname(`user/${other.id}/photo.jpg`, me.id)), "someone else's folder refused");
  assert(throws(() => assertUserUploadPathname(`user/${me.id}/../${other.id}/p.jpg`, me.id)), 'traversal refused');
  assert(throws(() => assertUserUploadPathname('photo.jpg', me.id)), 'unprefixed refused');
  assert(throws(() => assertUserUploadPathname(`ws/${bizA.wid}/p.jpg`, me.id)), 'workspace folder refused');
  assert(throws(() => assertUploadPathname(`user/${me.id}/p.jpg`, bizA.wid)), 'workspace token can never write into a user folder');
  assert(blobPathnameForUser(`https://abc.public.blob.vercel-storage.com/user/${me.id}/p.jpg`, me.id) === `user/${me.id}/p.jpg`, 'own blob URL resolves');
  assert(blobPathnameForUser(`https://evil.example.com/user/${me.id}/p.jpg`, me.id) === null, 'other host is not ours');

  console.log('\n[6] /api/me/photo-token');
  const tokenBody = (pathname) => ({ type: 'blob.generate-client-token', payload: { pathname, clientPayload: null, multipart: false } });
  r = await call(photoTokenHandler, { method: 'POST', body: tokenBody(`user/${me.id}/photo.jpg`) });
  assert(r.statusCode === 401, `signed out → 401 (${r.statusCode})`);
  r = await call(photoTokenHandler, { method: 'POST', cookie: me.cookie, body: tokenBody(`user/${me.id}/photo.jpg`) });
  assert(r.statusCode === 200 && typeof r.body?.clientToken === 'string', `own folder → token (${r.statusCode})`);
  r = await call(photoTokenHandler, { method: 'POST', cookie: me.cookie, body: tokenBody(`user/${other.id}/photo.jpg`) });
  assert(r.statusCode === 400 && !r.body?.clientToken, `other user's folder → 400 (${r.statusCode})`);
  r = await call(photoTokenHandler, { method: 'POST', cookie: me.cookie, body: tokenBody(`ws/${bizA.wid}/photo.jpg`) });
  assert(r.statusCode === 400, `a business folder → 400 (${r.statusCode})`);
  r = await call(photoTokenHandler, { method: 'GET', cookie: me.cookie });
  assert(r.statusCode === 405, 'GET not allowed');

  console.log('\n[7] /api/me/profile photoUrl checks');
  const patch = (photoUrl, who = me) => call(profileHandler, { method: 'PATCH', cookie: who.cookie, body: { photoUrl } });
  const mineUrl = `https://abc.public.blob.vercel-storage.com/user/${me.id}/photo-x1.jpg`;
  r = await patch(mineUrl);
  assert(r.statusCode === 200 && r.body?.profile?.photoUrl === mineUrl, `own uploaded photo saved (${r.statusCode})`);
  const both = await sql`SELECT photo_url FROM clients WHERE id IN (${myA}, ${myB})`;
  assert(both.rows.every((x) => x.photo_url === mineUrl), 'saved on every business I am a client of');
  const otherRow = await sql`SELECT photo_url FROM clients WHERE id = ${otherA}`;
  assert(otherRow.rows[0].photo_url !== mineUrl, "another client's row untouched");
  r = await patch(`https://abc.public.blob.vercel-storage.com/user/${other.id}/photo.jpg`);
  assert(r.statusCode === 400, `someone else's uploaded file refused (${r.statusCode})`);
  r = await patch(`https://abc.public.blob.vercel-storage.com/ws/${bizA.wid}/clients/x.jpg`);
  assert(r.statusCode === 400, `a business's file refused (${r.statusCode})`);
  r = await patch('javascript:alert(1)');
  assert(r.statusCode === 400, `javascript: refused (${r.statusCode})`);
  r = await patch('http://example.com/me.jpg');
  assert(r.statusCode === 400, `plain http refused (${r.statusCode})`);
  r = await patch('https://images.example.com/me.jpg');
  assert(r.statusCode === 200, `older app's https link still accepted (${r.statusCode})`);
  // A photo the business set for me (in its own folder) re-saves fine.
  const bizPhoto = `https://abc.public.blob.vercel-storage.com/ws/${bizA.wid}/clients/photo.jpg`;
  await sql`UPDATE clients SET photo_url = ${bizPhoto} WHERE id = ${myA}`;
  r = await patch(bizPhoto);
  assert(r.statusCode === 200, `unchanged existing photo re-saves (${r.statusCode})`);
  r = await patch(null);
  assert(r.statusCode === 200 && r.body?.profile?.photoUrl === null, 'remove photo');
  r = await call(profileHandler, { cookie: me.cookie });
  for (const k of ['name', 'email', 'phone', 'address', 'photoUrl']) assert(k in (r.body?.profile || {}), `profile still has ${k}`);

  console.log('\n[8] /api/me/export: client-safe, mine only, no workspace created');
  const wsBefore = await sql`SELECT COUNT(*)::int AS n FROM workspaces WHERE owner_id = ${me.id}`;
  r = await call(exportHandler, { cookie: me.cookie });
  const ex = r.body;
  const exRaw = typeof ex === 'string' ? ex : JSON.stringify(ex);
  assert(r.statusCode === 200 && /attachment/.test(r.headers['content-disposition'] || ''), `download (${r.statusCode})`);
  assert(Array.isArray(ex?.bookings) && ex.bookings.length === 2, `my 2 bookings (${ex?.bookings?.length})`);
  assert(ex?.invoices?.length === 1 && ex.invoices[0].number === 'CP-MINE-' + STAMP, 'my sent invoice only');
  assert(!exRaw.includes('OWNER SECRET') && !/private_?notes/i.test(exRaw), 'no private notes');
  assert(!exRaw.includes('HIDDEN SESSION NOTE'), 'no hidden session notes');
  assert(!exRaw.includes('OTHER') && !exRaw.includes(otherA), "nothing of the other client's");
  assert(!/stripe|payment_intent|token_hash|cus_x|pm_x/i.test(exRaw), 'no payment-processor ids or tokens');
  const wsAfter = await sql`SELECT COUNT(*)::int AS n FROM workspaces WHERE owner_id = ${me.id}`;
  assert(wsBefore.rows[0].n === 0 && wsAfter.rows[0].n === 0, 'downloading data does not make the client a business owner');
  r = await call(exportHandler, { method: 'DELETE', cookie: me.cookie });
  assert(r.statusCode === 405, 'other methods refused');
  r = await call(exportHandler, {});
  assert(r.statusCode === 401, `signed out → 401 (${r.statusCode})`);

  const before = sent.length;
  r = await call(exportHandler, { method: 'POST', cookie: me.cookie });
  assert(r.statusCode === 200 && r.body?.emailed === true, `email a copy (${r.statusCode})`);
  const mail = sent[sent.length - 1];
  assert(sent.length === before + 1 && (mail?.to === me.email || (Array.isArray(mail?.to) && mail.to.includes(me.email))), 'emailed to my own address');
  const att = mail?.attachments?.[0]?.content ? Buffer.from(mail.attachments[0].content, 'base64').toString('utf8') : '';
  assert(att.includes('CP-MINE-') && !att.includes('OWNER SECRET'), 'attachment is the safe export');
  await call(exportHandler, { method: 'POST', cookie: me.cookie });
  await call(exportHandler, { method: 'POST', cookie: me.cookie });
  r = await call(exportHandler, { method: 'POST', cookie: me.cookie });
  assert(r.statusCode === 429, `emailed copies are rate limited (${r.statusCode})`);

  console.log('\n[9] owner account export: client_portal section is the safe view');
  const full = await buildAccountExport({ id: ownerB.id, email: ownerB.email, email_verified_at: new Date() });
  assert(full && 'client_portal' in full, 'owner export still has client_portal');
  // ownerB is also a client of business A in this check:
  await sql`INSERT INTO clients (workspace_id, name, email, user_id, stage) VALUES (${bizA.wid}, 'Owner B as client', ${ownerB.email}, ${ownerB.id}, 'active')`;
  const cid = (await sql`SELECT id FROM clients WHERE user_id = ${ownerB.id} AND workspace_id = ${bizA.wid}`).rows[0].id;
  await sql`INSERT INTO bookings (workspace_id, client_id, service_id, client_name, date, start_min, end_min, private_notes)
    VALUES (${bizA.wid}, ${cid}, ${bizA.serviceId}, 'Owner B as client', ${day(6)}, 600, 660, 'A SECRET ABOUT OWNER B')`;
  const full2 = await buildAccountExport({ id: ownerB.id, email: ownerB.email, email_verified_at: new Date() });
  const cpRaw = JSON.stringify(full2.client_portal);
  assert(Array.isArray(full2.client_portal?.bookings) && full2.client_portal.bookings.length === 1, 'their booking with business A is there');
  assert(Array.isArray(full2.client_portal?.businesses) && full2.client_portal.businesses[0]?.clientId === cid, 'businesses keeps its old shape');
  assert(!cpRaw.includes('A SECRET ABOUT OWNER B'), "business A's private note is not in owner B's export");
}

async function cleanup() {
  for (const uid of userIds) {
    await sql`DELETE FROM workspaces WHERE owner_id = ${uid}`.catch(() => {});
  }
  for (const uid of userIds) {
    await sql`DELETE FROM users WHERE id = ${uid}`.catch(() => {});
  }
}

run().catch((e) => { fail++; console.log('  ✗ threw:', e.stack || e.message); })
  .finally(async () => {
    await cleanup().catch(() => {});
    console.log(`\n Pass: ${pass}  Fail: ${fail}`);
    process.exit(fail === 0 ? 0 : 1);
  });
