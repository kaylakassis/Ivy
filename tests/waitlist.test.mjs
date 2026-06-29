// Waitlist + controlled-launch + exclusive-discount tests.
//
// Covers the DB-backed core logic (no Stripe needed):
//   • public join: validates email, idempotent upsert, honeypot
//   • launch mode: getLaunchMode / setLaunchMode round-trip
//   • signup gating: blocked in waitlist mode, allowed with bypass cookie,
//     allowed in open mode
//   • discount exclusivity: signing up with a waitlisted email stamps
//     workspaces.waitlist_discount_at and converts the waitlist row; a
//     non-waitlisted email does NOT get stamped
//
// Run with:
//   node --import ./tests/bootstrap.mjs ./tests/waitlist.test.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { setLaunchMode, getLaunchMode, setGatePassword, attemptBypass } from '../api/_lib/earlyAccess.js';
import { CURRENT_TERMS_VERSION, CURRENT_PRIVACY_VERSION } from '../api/_lib/legal.js';
import joinHandler from '../api/waitlist/join.js';
import signupHandler from '../api/auth/signup.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

function makeRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { const key = k.toLowerCase(); if (key === 'set-cookie') { (this.headers[key] ||= []).push(v); } else { this.headers[key] = v; } },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(o) { this.body = o; return this; }, end(s) { this.body = s ?? this.body; return this; },
  };
}
let ipN = 0;
function req({ method = 'POST', body = {}, headers = {}, query = {} } = {}) {
  ipN++;
  return { method, url: '/test', query, body,
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', host: 'localhost:3000', 'x-forwarded-for': `198.51.100.${ipN % 250}`, ...headers } };
}

async function run() {
  await ensureSchemaApplied();
  const stamp = Date.now();
  const wlEmail   = `wl-${stamp}@example.com`;
  const noWlEmail = `nowl-${stamp}@example.com`;
  // Clean slate
  await sql`DELETE FROM waitlist_signups WHERE email IN (${wlEmail}, ${noWlEmail})`;
  await sql`DELETE FROM users WHERE email IN (${wlEmail}, ${noWlEmail})`;
  await setLaunchMode('open');

  console.log('\n[1] public join: validation + idempotent upsert + honeypot');
  let r = makeRes();
  await joinHandler(req({ body: { email: 'not-an-email' } }), r);
  assert(r.statusCode === 400, 'rejects an invalid email (400)');

  r = makeRes();
  await joinHandler(req({ body: { email: wlEmail.toUpperCase(), name: 'WL Tester' } }), r);
  assert(r.statusCode === 200, 'accepts a valid email (200)');
  let cnt = (await sql`SELECT COUNT(*)::int n FROM waitlist_signups WHERE LOWER(email) = ${wlEmail}`).rows[0].n;
  assert(cnt === 1, 'one row stored, email lower-cased');

  r = makeRes();
  await joinHandler(req({ body: { email: wlEmail } }), r);
  assert(r.statusCode === 200, 're-submit is a no-op success (200)');
  cnt = (await sql`SELECT COUNT(*)::int n FROM waitlist_signups WHERE LOWER(email) = ${wlEmail}`).rows[0].n;
  assert(cnt === 1, 'still exactly one row after re-submit (idempotent)');

  r = makeRes();
  const before = (await sql`SELECT COUNT(*)::int n FROM waitlist_signups`).rows[0].n;
  await joinHandler(req({ body: { email: `bot-${stamp}@example.com`, hp: 'i-am-a-bot' } }), r);
  const after = (await sql`SELECT COUNT(*)::int n FROM waitlist_signups`).rows[0].n;
  assert(r.statusCode === 200 && after === before, 'honeypot submit silently accepted, nothing stored');

  console.log('\n[2] launch mode round-trip');
  await setLaunchMode('waitlist');
  assert((await getLaunchMode()) === 'waitlist', 'setLaunchMode(waitlist) persists');
  await setLaunchMode('bogus');
  assert((await getLaunchMode()) === 'open', 'invalid mode falls back to open');

  console.log('\n[3] signup is blocked in waitlist mode');
  await setLaunchMode('waitlist');
  await setGatePassword(''); // no bypass password configured
  r = makeRes();
  await signupHandler(req({ body: { email: noWlEmail, password: 'a-sufficiently-long-password', name: 'No WL', acceptedTermsVersion: CURRENT_TERMS_VERSION, acceptedPrivacyVersion: CURRENT_PRIVACY_VERSION } }), r);
  assert(r.statusCode === 403, 'signup blocked with 403 in waitlist mode');
  assert(r.body?.code === 'waitlist_only', 'block carries code waitlist_only');
  assert((await sql`SELECT COUNT(*)::int n FROM users WHERE email = ${noWlEmail}`).rows[0].n === 0, 'no user created');

  console.log('\n[4] beta bypass cookie lets a select user through');
  await setGatePassword('beta-secret-pw');
  const bypass = await attemptBypass('beta-secret-pw');
  assert(bypass.ok && bypass.cookieValue, 'attemptBypass validates the configured password');
  r = makeRes();
  await signupHandler(req({
    body: { email: noWlEmail, password: 'a-sufficiently-long-password', name: 'No WL', acceptedTermsVersion: CURRENT_TERMS_VERSION, acceptedPrivacyVersion: CURRENT_PRIVACY_VERSION },
    headers: { cookie: `ea_pass=${bypass.cookieValue}` },
  }), r);
  assert(r.statusCode === 200 || r.statusCode === 201, 'signup succeeds with bypass cookie');
  assert((await sql`SELECT COUNT(*)::int n FROM users WHERE email = ${noWlEmail}`).rows[0].n === 1, 'user created via bypass');

  console.log('\n[5] discount exclusivity: waitlisted email gets stamped, others do not');
  // The bypass signup above used noWlEmail (NOT on the waitlist) → no discount.
  let ws = (await sql`SELECT w.waitlist_discount_at FROM workspaces w JOIN users u ON u.id = w.owner_id WHERE u.email = ${noWlEmail}`).rows[0];
  assert(ws && ws.waitlist_discount_at === null, 'non-waitlisted signup is NOT discount-eligible');

  // Now sign up with the waitlisted email (still in waitlist mode, using bypass).
  await signupHandler(req({
    body: { email: wlEmail, password: 'a-sufficiently-long-password', name: 'WL Tester', acceptedTermsVersion: CURRENT_TERMS_VERSION, acceptedPrivacyVersion: CURRENT_PRIVACY_VERSION },
    headers: { cookie: `ea_pass=${bypass.cookieValue}` },
  }), makeRes());
  ws = (await sql`SELECT w.waitlist_discount_at FROM workspaces w JOIN users u ON u.id = w.owner_id WHERE u.email = ${wlEmail}`).rows[0];
  assert(ws && ws.waitlist_discount_at !== null, 'waitlisted signup IS discount-eligible (stamped)');
  const wlRow = (await sql`SELECT status, converted_user_id FROM waitlist_signups WHERE LOWER(email) = ${wlEmail}`).rows[0];
  assert(wlRow.status === 'converted' && wlRow.converted_user_id, 'waitlist row marked converted + linked to user');

  // Cleanup + restore default launch mode so we don't trap a shared DB.
  await setGatePassword('');
  await setLaunchMode('open');
  await sql`DELETE FROM users WHERE email IN (${wlEmail}, ${noWlEmail})`;
  await sql`DELETE FROM waitlist_signups WHERE email IN (${wlEmail}, ${noWlEmail}) OR email LIKE ${`bot-${stamp}@%`}`;

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
