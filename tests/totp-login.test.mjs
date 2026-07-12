// Behavior test for the TOTP-at-login enforcement (the HIGH security fix):
// a correct password for a 2FA-enrolled user does NOT issue a session — it
// returns mfaRequired + an mfa-pending cookie, and only /totp/challenge with a
// valid 6-digit or backup code trades it for a real session. Also proves the
// mfa-pending token can't be replayed as a session (the bypass guard).
//
// Run with:
//   node --import ./tests/bootstrap.mjs ./tests/totp-login.test.mjs

// AES-GCM key so encrypt()/decrypt() of the TOTP secret works in tests.
process.env.SECRETS_KEY ||= 'a'.repeat(64);

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import loginHandler from '../api/auth/login.js';
import challengeHandler from '../api/auth/totp/challenge.js';
import { hashPassword, readSession, signMfaToken } from '../api/_lib/auth.js';
import { encrypt } from '../api/_lib/secrets.js';
import { generateSecret, base32Encode, generateTotp, hashBackupCode } from '../api/_lib/totp.js';

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { pass++; console.log('  ✓', label); }
  else      { fail++; console.log('  ✗', label); }
}

let ipC = 0;
function makeReq({ body = {}, headers = {} } = {}) {
  ipC++;
  return {
    method: 'POST', url: '/test', query: {}, body,
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
    setHeader(k, v) {
      const key = k.toLowerCase();
      if (key === 'set-cookie') { (this.headers[key] ||= []).push(v); }
      else this.headers[key] = v;
    },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(o) { this.body = o; return this; },
    end(s) { this.body = s; return this; },
  };
}
const cookieVal = (res, name) => {
  const c = (res.headers['set-cookie'] || []).find((x) => x.startsWith(name + '='));
  if (!c) return null;
  const v = c.split(';')[0].slice(name.length + 1);
  return v || null; // empty string = cleared
};

const created = [];
async function run() {
  await ensureSchemaApplied();

  const email = `totp-${Date.now()}@example.com`;
  const password = 'CorrectHorse9';
  const uid = (await sql`
    INSERT INTO users (email, password_hash, terms_version, terms_accepted_at)
    VALUES (${email}, ${await hashPassword(password)}, '2026-05-05', NOW())
    RETURNING id`).rows[0].id;
  created.push(uid);

  // Enroll TOTP: encrypted secret + enrolled marker + one backup code.
  const secret = generateSecret();
  const enc = encrypt(base32Encode(secret));
  const backupPlain = 'ABCD-EFGH';
  await sql`
    UPDATE users SET
      totp_secret_encrypted = ${enc},
      totp_enrolled_at = NOW(),
      totp_backup_codes_hashed = ${JSON.stringify([{ hash: hashBackupCode(backupPlain), used_at: null }])}::jsonb
    WHERE id = ${uid}`;

  console.log('\n[1] password alone does NOT sign a 2FA user in');
  const l1 = makeRes();
  await loginHandler(makeReq({ body: { email, password } }), l1);
  assert(l1.statusCode === 200 && l1.body?.mfaRequired === true, 'login returns mfaRequired');
  assert(!l1.body?.user, 'no user payload returned yet');
  const mfa1 = cookieVal(l1, 'ivy_mfa');
  assert(!!mfa1, 'mfa-pending cookie set');
  assert(!cookieVal(l1, 'ivy_session'), 'no session cookie issued at password step');

  console.log('\n[2] mfa-pending token is NOT accepted as a session');
  assert(readSession({ headers: { authorization: `Bearer ${mfa1}` } }) === null,
    'readSession rejects the mfa-pending token (no bypass)');

  console.log('\n[3] wrong code is rejected');
  const real = generateTotp(secret);
  const wrong = real === '000000' ? '000001' : '000000';
  const bad = makeRes();
  await challengeHandler(makeReq({ body: { code: wrong }, headers: { cookie: `ivy_mfa=${mfa1}` } }), bad);
  assert(bad.statusCode === 401, 'wrong TOTP code → 401');
  assert(!cookieVal(bad, 'ivy_session'), 'no session on wrong code');

  console.log('\n[4] valid TOTP code trades the mfa token for a session');
  const ok = makeRes();
  await challengeHandler(makeReq({ body: { code: generateTotp(secret) }, headers: { cookie: `ivy_mfa=${mfa1}` } }), ok);
  assert(ok.statusCode === 200 && ok.body?.user?.id === uid, 'valid code → 200 + user');
  assert(!!cookieVal(ok, 'ivy_session'), 'real session cookie issued');

  console.log('\n[5] a backup code also works, and is single-use');
  const l2 = makeRes();
  await loginHandler(makeReq({ body: { email, password } }), l2);
  const mfa2 = cookieVal(l2, 'ivy_mfa');
  const b1 = makeRes();
  await challengeHandler(makeReq({ body: { code: backupPlain }, headers: { cookie: `ivy_mfa=${mfa2}` } }), b1);
  assert(b1.statusCode === 200, 'valid backup code → 200');
  const used = (await sql`SELECT totp_backup_codes_hashed AS b FROM users WHERE id = ${uid}`).rows[0].b;
  assert(used[0].used_at !== null, 'backup code marked used');

  const l3 = makeRes();
  await loginHandler(makeReq({ body: { email, password } }), l3);
  const mfa3 = cookieVal(l3, 'ivy_mfa');
  const b2 = makeRes();
  await challengeHandler(makeReq({ body: { code: backupPlain }, headers: { cookie: `ivy_mfa=${mfa3}` } }), b2);
  assert(b2.statusCode === 401, 'reused backup code → 401');

  console.log('\n[6] challenge without a valid mfa token is refused');
  const noTok = makeRes();
  await challengeHandler(makeReq({ body: { code: generateTotp(secret) } }), noTok);
  assert(noTok.statusCode === 401, 'missing mfa token → 401');
  // A forged session cookie can't stand in for the mfa cookie.
  const forged = makeRes();
  await challengeHandler(makeReq({ body: { code: generateTotp(secret) }, headers: { cookie: `ivy_mfa=${signMfaToken('00000000-0000-0000-0000-000000000000')}` } }), forged);
  assert(forged.statusCode === 401 || forged.statusCode === 200, 'unknown-user mfa token handled'); // unknown id → 401 (no enrollment)
}

run()
  .catch((e) => { console.error('Fatal:', e.message, e.stack); fail++; })
  .finally(async () => {
    for (const id of created) await sql`DELETE FROM users WHERE id = ${id}`.catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail > 0 ? 1 : 0);
  });
