// Waitlist v2: full signup details + consent, Google Sheet mirror, personal
// invites that open the gate for one person while launch mode is waitlist.
// Run: node --import ./tests/bootstrap.mjs ./tests/waitlist-invite.test.mjs
process.env.SUPER_ADMIN_EMAIL = `wl-admin-${Date.now()}@example.com`;
process.env.WAITLIST_SHEET_WEBHOOK_URL = 'https://script.google.com/macros/s/test/exec';

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { setLaunchMode, hasBypassCookie, makeInviteToken, verifyInviteToken } from '../api/_lib/earlyAccess.js';
import { CURRENT_TERMS_VERSION, CURRENT_PRIVACY_VERSION } from '../api/_lib/legal.js';
import { hashPassword, signSession } from '../api/_lib/auth.js';
import joinHandler from '../api/waitlist/join.js';
import adminList from '../api/admin/waitlist.js';
import inviteHandler from '../api/admin/waitlist-invite.js';
import redeemHandler from '../api/early-access/invite.js';
import signupHandler from '../api/auth/signup.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
function makeRes() {
  return { statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { const key = k.toLowerCase(); if (key === 'set-cookie') { (this.headers[key] ||= []).push(v); } else { this.headers[key] = v; } },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(o) { this.body = o; return this; }, end(s) { this.body = s ?? this.body; return this; }, write() {} };
}
let ipN = 0;
function req({ method = 'POST', body = {}, headers = {}, query = {} } = {}) {
  ipN++;
  return { method, url: '/test', query, body, headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', host: 'localhost:3000', 'x-forwarded-for': `203.0.113.${ipN % 250}`, ...headers } };
}
const cookieOf = (res, name) => { const c = (res.headers['set-cookie'] || []).find((x) => x.startsWith(name + '=')); return c ? decodeURIComponent(c.split(';')[0].slice(name.length + 1)) : null; };

// Capture the sheet webhook instead of calling Google.
const sheetPosts = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (String(url).includes('script.google.com')) { sheetPosts.push(JSON.parse(opts.body)); return { ok: true, status: 200 }; }
  return realFetch(url, opts);
};

async function run() {
  await ensureSchemaApplied();
  const S = Date.now();
  const email = `wl2-${S}@example.com`;
  const admin = await sql`INSERT INTO users (email, password_hash, name, email_verified_at, user_type) VALUES (${process.env.SUPER_ADMIN_EMAIL}, ${await hashPassword('x'.repeat(12))}, 'Admin', NOW(), 'super_admin') RETURNING id`;
  const adminCookie = `ivy_session=${signSession(admin.rows[0].id)}`;

  console.log('\n[1] join collects name, phone, email and consent');
  let r = makeRes();
  await joinHandler(req({ body: { firstName: 'Priya', lastName: 'Shah', email, phone: '(555) 010-2222', consent: false } }), r);
  assert(r.statusCode === 400 && /let you know/.test(r.body?.error || ''), 'no consent → 400 with a plain reason');
  r = makeRes();
  await joinHandler(req({ body: { firstName: 'Priya', email, phone: '5550102222', consent: true } }), r);
  assert(r.statusCode === 400 && /last name/.test(r.body?.error || ''), 'missing last name → 400');
  r = makeRes();
  await joinHandler(req({ body: { firstName: 'Priya', lastName: 'Shah', email: email.toUpperCase(), phone: '(555) 010-2222', consent: true, source: 'waitlist-landing' } }), r);
  assert(r.statusCode === 200, 'full signup accepted');
  let row = (await sql`SELECT * FROM waitlist_signups WHERE LOWER(email) = ${email}`).rows[0];
  assert(row && row.first_name === 'Priya' && row.last_name === 'Shah' && row.name === 'Priya Shah', 'names stored (and legacy name filled)');
  assert(row.phone === '(555) 010-2222' && row.contact_consent === true && !!row.consent_at, 'phone and consent stored with a timestamp');
  await new Promise((res) => setTimeout(res, 50));
  assert(sheetPosts.length === 1 && sheetPosts[0].email === email && sheetPosts[0].consent === 'yes' && sheetPosts[0].firstName === 'Priya', 'row mirrored to the Google Sheet webhook');
  r = makeRes();
  await joinHandler(req({ body: { firstName: 'Priya', lastName: 'Shah', email, phone: '5550102222', consent: true } }), r);
  await new Promise((res) => setTimeout(res, 50));
  assert(r.statusCode === 200 && sheetPosts.length === 1, 'repeat submit is a no-op: one row, one sheet post');

  console.log('\n[2] admin list and CSV carry the new fields');
  r = makeRes();
  await adminList(req({ method: 'GET', query: { q: 'priya' }, headers: { cookie: adminCookie } }), r);
  const item = (r.body?.items || []).find((i) => i.email === email);
  assert(item && item.firstName === 'Priya' && item.phone === '(555) 010-2222' && item.consent === true && item.status === 'pending', 'list shows name, phone, consent, status');
  assert(r.body.sheetConfigured === true, 'list reports the sheet mirror is configured');

  console.log('\n[3] waitlist mode blocks signup until invited');
  await setLaunchMode('waitlist');
  const signupBody = { email, password: 'a-sufficiently-long-password', name: 'Priya Shah', acceptedTermsVersion: CURRENT_TERMS_VERSION, acceptedPrivacyVersion: CURRENT_PRIVACY_VERSION };
  r = makeRes();
  await signupHandler(req({ body: signupBody }), r);
  assert(r.statusCode === 403 && r.body?.code === 'waitlist_only', `blocked without an invite (${r.statusCode})`);

  r = makeRes();
  await inviteHandler(req({ body: { id: row.id }, headers: { cookie: adminCookie } }), r);
  assert(r.statusCode === 200 && /\/signup\?invite=/.test(r.body?.link || ''), 'admin invite returns a personal link');
  const token = decodeURIComponent(r.body.link.split('invite=')[1]);
  row = (await sql`SELECT status, invited_at FROM waitlist_signups WHERE id = ${row.id}`).rows[0];
  assert(row.status === 'invited' && !!row.invited_at, 'row marked invited');
  const data = verifyInviteToken(token);
  assert(data && data.email === email, 'token verifies to that email');
  assert(verifyInviteToken(token.slice(0, -2) + 'zz') === null, 'tampered token rejected');
  assert(verifyInviteToken(makeInviteToken(row.id || 'x', email, -1)) === null, 'expired token rejected');

  r = makeRes();
  await redeemHandler(req({ body: { token: 'nonsense' } }), r);
  assert(r.statusCode === 400, 'bad token cannot be redeemed');
  r = makeRes();
  await redeemHandler(req({ body: { token } }), r);
  const inviteCookie = cookieOf(r, 'ea_invite');
  assert(r.statusCode === 200 && !!inviteCookie, 'valid token sets the invite cookie');
  assert(await hasBypassCookie(req({ headers: { cookie: `ea_invite=${encodeURIComponent(inviteCookie)}` } })) === true, 'invite cookie counts as a bypass');

  r = makeRes();
  await signupHandler(req({ body: signupBody, headers: { cookie: `ea_invite=${encodeURIComponent(inviteCookie)}` } }), r);
  assert(r.statusCode === 200 || r.statusCode === 201, `signup succeeds with the invite (${r.statusCode})`);
  row = (await sql`SELECT status FROM waitlist_signups WHERE LOWER(email) = ${email}`).rows[0];
  assert(row.status === 'converted', 'row marked converted after signup');

  console.log('\n[4] deleting the row revokes the invite; flipping to open removes the gate');
  const other = `wl2b-${S}@example.com`;
  r = makeRes(); await joinHandler(req({ body: { firstName: 'Lee', lastName: 'Park', email: other, consent: true } }), r);
  const otherRow = (await sql`SELECT id FROM waitlist_signups WHERE LOWER(email) = ${other}`).rows[0];
  const t2 = makeInviteToken(otherRow.id, other);
  await sql`DELETE FROM waitlist_signups WHERE id = ${otherRow.id}`;
  assert(await hasBypassCookie(req({ headers: { cookie: `ea_invite=${encodeURIComponent(t2)}` } })) === false, 'deleted row → invite no longer works');
  await setLaunchMode('open');
  r = makeRes();
  await signupHandler(req({ body: { ...signupBody, email: `open-${S}@example.com`, name: 'Open User' } }), r);
  assert(r.statusCode === 200 || r.statusCode === 201, 'open mode: anyone can sign up again');

  await sql`DELETE FROM users WHERE id = ${admin.rows[0].id}`;
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
run().catch((e) => { console.error('crashed:', e); process.exit(1); });
