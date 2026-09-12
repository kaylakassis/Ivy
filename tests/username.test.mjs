// Usernames: required at sign-up, unique, usable to sign in.
// Run: node --import ./tests/bootstrap.mjs ./tests/username.test.mjs
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { CURRENT_TERMS_VERSION, CURRENT_PRIVACY_VERSION } from '../api/_lib/legal.js';
import signupHandler from '../api/auth/signup.js';
import loginHandler from '../api/auth/login.js';
import availableHandler from '../api/auth/username-available.js';
import profileHandler from '../api/me/profile.js';
import { signSession } from '../api/_lib/auth.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '{}' });
function mockRes() {
  return { statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; }, setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; }, json(o) { this.body = o; return this; },
    end(s) { this.body = s ?? this.body; return this; }, writeHead(c) { this.statusCode = c; return this; } };
}
let ipN = 0;
const req = ({ method = 'POST', body = {}, query = {}, cookie } = {}) => { ipN++; return { method, url: '/t', query, body,
  headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', host: 'localhost:3000', 'user-agent': 'test',
    'x-forwarded-for': `198.18.3.${(ipN % 200) + 10}`, ...(cookie ? { cookie } : {}) } }; };
const S = Date.now();
const legal = { acceptedTermsVersion: CURRENT_TERMS_VERSION, acceptedPrivacyVersion: CURRENT_PRIVACY_VERSION };
const signup = async (b) => { const r = mockRes(); await signupHandler(req({ body: { password: 'a-long-enough-password-1', name: 'Test User', ...legal, ...b } }), r); return r; };

async function run() {
  await ensureSchemaApplied();
  console.log('\n[1] sign-up requires a well-formed, unique username');
  let r = await signup({ email: `u1-${S}@example.com` });
  assert(r.statusCode === 400 && /username/i.test(r.body?.error || ''), `missing username rejected ("${r.body?.error}")`);
  r = await signup({ email: `u1-${S}@example.com`, username: 'ab' });
  assert(r.statusCode === 400 && /3 characters/.test(r.body?.error || ''), 'too short rejected');
  r = await signup({ email: `u1-${S}@example.com`, username: 'kay la' });
  assert(r.statusCode === 400, 'space rejected');
  r = await signup({ email: `u1-${S}@example.com`, username: 'admin' });
  assert(r.statusCode === 400 && /reserved/.test(r.body?.error || ''), 'reserved handle rejected');
  const handle = `coach_kay.${S.toString(36)}`;
  r = await signup({ email: `u1-${S}@example.com`, username: '@' + handle.toUpperCase() });
  assert(r.statusCode === 201 && r.body?.user?.username === handle, `created; handle stored lowercase without the @ (${r.body?.user?.username})`);
  r = await signup({ email: `u2-${S}@example.com`, username: handle });
  assert(r.statusCode === 400 && /taken/.test(r.body?.error || ''), 'same handle for a second account is refused');
  r = await signup({ email: `u2-${S}@example.com`, username: handle.toUpperCase() });
  assert(r.statusCode === 400, 'case-insensitive: KAY == kay');

  console.log('\n[2] availability check');
  r = mockRes(); await availableHandler(req({ method: 'GET', query: { u: handle } }), r);
  assert(r.body?.available === false, 'taken handle reported unavailable');
  r = mockRes(); await availableHandler(req({ method: 'GET', query: { u: `free_${S.toString(36)}` } }), r);
  assert(r.body?.available === true, 'free handle reported available');
  r = mockRes(); await availableHandler(req({ method: 'GET', query: { u: 'x' } }), r);
  assert(r.body?.available === false && /3 characters/.test(r.body?.error || ''), 'bad shape explained');

  console.log('\n[3] sign in with the username or the email');
  r = mockRes(); await loginHandler(req({ body: { email: handle, password: 'a-long-enough-password-1' } }), r);
  assert(r.statusCode === 200 && r.body?.user?.username === handle, `login by username (got ${r.statusCode})`);
  r = mockRes(); await loginHandler(req({ body: { email: `u1-${S}@example.com`, password: 'a-long-enough-password-1' } }), r);
  assert(r.statusCode === 200, 'login by email still works');
  r = mockRes(); await loginHandler(req({ body: { email: handle, password: 'wrong-wrong-wrong' } }), r);
  assert(r.statusCode === 401 && /attempts left/.test(r.body?.error || ''), 'wrong password by username counts toward the lock');

  console.log('\n[4] profile can change the handle, but not onto a taken one');
  const uid = (await sql`SELECT id FROM users WHERE email = ${`u1-${S}@example.com`}`).rows[0].id;
  const cookie = `ivy_session=${signSession(uid)}`;
  const other = await signup({ email: `u3-${S}@example.com`, username: `taken_${S.toString(36)}` });
  assert(other.statusCode === 201, 'second account created');
  r = mockRes(); await profileHandler(req({ method: 'PATCH', cookie, body: { username: `taken_${S.toString(36)}` } }), r);
  assert(r.statusCode === 400, `cannot take another account's handle (got ${r.statusCode})`);
  r = mockRes(); await profileHandler(req({ method: 'PATCH', cookie, body: { username: `renamed_${S.toString(36)}` } }), r);
  assert(r.statusCode === 200, `handle changed (got ${r.statusCode}: ${JSON.stringify(r.body).slice(0, 80)})`);
  r = mockRes(); await profileHandler(req({ method: 'GET', cookie }), r);
  assert(r.body?.profile?.username === `renamed_${S.toString(36)}`, 'profile reports the new handle');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
run().catch((e) => { console.error('username test crashed:', e); process.exit(1); });
