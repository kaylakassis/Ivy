// Two-factor setup end to end: enroll → verify → /auth/me shows it on →
// sign-in now needs a code → disable with password → off again.
// Run: node --import ./tests/bootstrap.mjs ./tests/totp-enroll.test.mjs
process.env.SECRETS_KEY ||= 'a'.repeat(64);

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import enrollHandler from '../api/auth/totp/enroll.js';
import verifyHandler from '../api/auth/totp/verify.js';
import disableHandler from '../api/auth/totp/disable.js';
import meHandler from '../api/auth/me.js';
import loginHandler from '../api/auth/login.js';
import { hashPassword, signSession } from '../api/_lib/auth.js';
import { base32Decode, generateTotp } from '../api/_lib/totp.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

let ipC = 0;
function makeReq({ method = 'POST', body = {}, headers = {} } = {}) {
  ipC++;
  return {
    method, url: '/test', query: {}, body,
    headers: {
      'content-type': 'application/json',
      origin: 'http://localhost:3000', host: 'localhost:3000',
      'x-forwarded-for': `198.51.100.${10 + (ipC % 200)}`,
      ...headers,
    },
  };
}
function makeRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { const key = k.toLowerCase(); if (key === 'set-cookie') { (this.headers[key] ||= []).push(v); } else this.headers[key] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(o) { this.body = o; return this; },
    end(s) { this.body = s; return this; },
  };
}
const hasCookie = (res, name) => (res.headers['set-cookie'] || []).some((c) => c.startsWith(name + '=') && !c.startsWith(name + '=;'));

async function run() {
  await ensureSchemaApplied();
  const email = `totp-enroll-${Date.now()}@example.com`;
  const password = 'correct horse battery';
  const { rows: [u] } = await sql`
    INSERT INTO users (email, password_hash, name, email_verified_at, terms_version, terms_accepted_at)
    VALUES (${email}, ${await hashPassword(password)}, 'Owner', NOW(), '2026-05-05', NOW()) RETURNING id`;
  const cookie = `ivy_session=${signSession(u.id)}`;
  const authed = (opts = {}) => makeReq({ ...opts, headers: { cookie, ...(opts.headers || {}) } });

  console.log('\n[1] before: off, and /auth/me says so');
  let r = makeRes(); await meHandler(authed({ method: 'GET' }), r);
  assert(r.statusCode === 200 && r.body.user.totp_enrolled_at == null, '/auth/me exposes totp_enrolled_at = null');
  assert(!('totp_secret_encrypted' in r.body.user) && !('totp_backup_codes_hashed' in r.body.user), 'secret and backup hashes never leave the server');

  console.log('\n[2] enroll returns what the screen needs');
  r = makeRes(); await enrollHandler(authed(), r);
  assert(r.statusCode === 200 && /^[A-Z2-7]+$/.test(r.body.secret), `base32 secret returned (${r.statusCode})`);
  assert(/^otpauth:\/\/totp\//.test(r.body.otpauth) && r.body.otpauth.includes('Ivy'), 'otpauth URI for the QR code');
  assert(Array.isArray(r.body.backupCodes) && r.body.backupCodes.length === 10, '10 backup codes shown once');
  const secret = base32Decode(r.body.secret);

  console.log('\n[3] not gated until a code is verified');
  r = makeRes(); await meHandler(authed({ method: 'GET' }), r);
  assert(r.body.user.totp_enrolled_at == null, 'still off after enroll alone');
  r = makeRes(); await loginHandler(makeReq({ body: { email, password } }), r);
  assert(hasCookie(r, 'ivy_session') && !r.body?.mfaRequired, 'password-only sign-in still works mid-setup');

  console.log('\n[4] wrong code rejected, right code turns it on');
  r = makeRes(); await verifyHandler(authed({ body: { code: '000000' } }), r);
  assert(r.statusCode === 400, 'wrong code → 400');
  r = makeRes(); await verifyHandler(authed({ body: { code: generateTotp(secret) } }), r);
  assert(r.statusCode === 200 && r.body.enrolled === true, 'valid code → enrolled');
  r = makeRes(); await meHandler(authed({ method: 'GET' }), r);
  assert(!!r.body.user.totp_enrolled_at, '/auth/me shows it on immediately (cache invalidated)');
  r = makeRes(); await loginHandler(makeReq({ body: { email, password } }), r);
  assert(r.body?.mfaRequired === true && !hasCookie(r, 'ivy_session'), 'sign-in now stops for a code');

  console.log('\n[5] disable needs the password');
  r = makeRes(); await disableHandler(authed({ body: { password: 'nope' } }), r);
  assert(r.statusCode === 401 || r.statusCode === 400, `wrong password refused (${r.statusCode})`);
  r = makeRes(); await meHandler(authed({ method: 'GET' }), r);
  assert(!!r.body.user.totp_enrolled_at, 'still on after a bad attempt');
  r = makeRes(); await disableHandler(authed({ body: { password } }), r);
  assert(r.statusCode === 200 && r.body.enrolled === false, 'right password → off');
  r = makeRes(); await meHandler(authed({ method: 'GET' }), r);
  assert(r.body.user.totp_enrolled_at == null, '/auth/me shows it off immediately');
  r = makeRes(); await loginHandler(makeReq({ body: { email, password } }), r);
  assert(hasCookie(r, 'ivy_session'), 'password-only sign-in works again');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
run().catch((e) => { console.error('crashed:', e); process.exit(1); });
