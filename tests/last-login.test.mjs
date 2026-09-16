// last_login_at: api/auth/login.js stamps the column on a successful sign-in,
// signup does NOT (created_at covers that), and the admin Users list surfaces
// it as `lastLoginAt`. Confirms the admin "Last login" column has real data.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/last-login.test.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import signupHandler from '../api/auth/signup.js';
import loginHandler from '../api/auth/login.js';
import usersHandler from '../api/admin/users.js';
import { CURRENT_TERMS_VERSION, CURRENT_PRIVACY_VERSION } from '../api/_lib/legal.js';

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
const EMAIL = `lastlogin-${Date.now()}@example.com`;
let ipN = 0;
function req({ method = 'POST', body = {}, headers = {}, query = {} } = {}) {
  ipN++;
  return { method, url: '/test', query, body,
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', host: 'localhost:3000', 'x-forwarded-for': `203.0.113.${ipN}`, ...headers } };
}

async function run() {
  try {
    await ensureSchemaApplied();
    await sql`DELETE FROM users WHERE email = ${EMAIL}`;

    console.log('\n[1] signup does not stamp last_login_at');
    let r = makeRes();
    await signupHandler(req({ body: { email: EMAIL, password: 'a-sufficiently-long-password', name: 'LL', acceptedTermsVersion: CURRENT_TERMS_VERSION, acceptedPrivacyVersion: CURRENT_PRIVACY_VERSION } }), r);
    assert(r.statusCode === 200 || r.statusCode === 201, 'signup ok');
    let row = (await sql`SELECT last_login_at FROM users WHERE email = ${EMAIL}`).rows[0];
    assert(row && row.last_login_at === null, 'last_login_at is NULL right after signup');

    console.log('\n[2] a successful login stamps last_login_at');
    r = makeRes();
    await loginHandler(req({ body: { email: EMAIL, password: 'a-sufficiently-long-password' } }), r);
    assert(r.statusCode === 200, 'login returns 200');
    row = (await sql`SELECT last_login_at FROM users WHERE email = ${EMAIL}`).rows[0];
    assert(!!row.last_login_at, 'last_login_at is now set');
    const firstStamp = new Date(row.last_login_at).getTime();
    assert(Math.abs(Date.now() - firstStamp) < 60_000, 'stamp is ~now');

    console.log('\n[3] a failed login does NOT advance the stamp');
    await new Promise((res) => setTimeout(res, 20));
    r = makeRes();
    await loginHandler(req({ body: { email: EMAIL, password: 'wrong-password' } }), r);
    assert(r.statusCode === 401, 'bad password → 401');
    row = (await sql`SELECT last_login_at FROM users WHERE email = ${EMAIL}`).rows[0];
    assert(new Date(row.last_login_at).getTime() === firstStamp, 'stamp unchanged after a failed login');

    console.log('\n[4] admin Users list returns lastLoginAt');
    const adminReq = req({ method: 'GET', query: { q: EMAIL }, headers: { 'x-admin-secret': process.env.ADMIN_SECRET || 'test-admin-secret' } });
    process.env.ADMIN_SECRET ||= 'test-admin-secret';
    r = makeRes();
    await usersHandler(adminReq, r);
    assert(r.statusCode === 200, 'admin users list returns 200');
    const found = (r.body?.users || []).find((u) => u.email === EMAIL);
    assert(!!found, 'our user is in the list');
    assert(!!found?.lastLoginAt, 'list row carries lastLoginAt');
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  } finally {
    await sql`DELETE FROM users WHERE email = ${EMAIL}`.catch(() => {});
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
run();
