// Login lockout counts FAILURES, not sign-ins.
//   - Six correct sign-ins in a row from one IP all succeed (the owner
//     signing in on a phone, a laptop and a private window used to lock
//     herself out at the fifth attempt with the right password).
//   - Five wrong passwords still lock the email for the hour, and the
//     message says how long to wait.
// Run: node --import ./tests/bootstrap.mjs ./tests/login-lockout.test.mjs
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { hashPassword } from '../api/_lib/auth.js';
import loginHandler from '../api/auth/login.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '{}' });

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
const IP = `198.18.77.${Math.floor(Math.random() * 200) + 10}`;
const req = (body) => ({ method: 'POST', url: '/api/auth/login', query: {}, body,
  headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', host: 'localhost:3000', 'x-forwarded-for': IP, 'user-agent': 'test' } });

const STAMP = Date.now();
const EMAIL = `lockout-${STAMP}@example.com`;
const PW = 'Correct-horse-battery-9!';

async function run() {
  await ensureSchemaApplied();
  await sql`INSERT INTO users (email, password_hash, name, email_verified_at) VALUES (${EMAIL}, ${await hashPassword(PW)}, 'Lock Out', NOW())`;

  console.log('\n[1] six correct sign-ins in a row all succeed');
  let codes = [];
  for (let i = 0; i < 6; i++) { const r = mockRes(); await loginHandler(req({ email: EMAIL, password: PW }), r); codes.push(r.statusCode); }
  assert(codes.every((c) => c === 200), `all 200 (got ${codes.join(',')})`);

  console.log('\n[2] each miss says how many attempts are left; the fifth locks for 60 minutes');
  const results = [];
  for (let i = 0; i < 5; i++) { const r = mockRes(); await loginHandler(req({ email: EMAIL, password: 'nope-' + i }), r); results.push(r); }
  assert(results.slice(0, 4).every((r) => r.statusCode === 401), `misses 1-4 are 401 (got ${results.map((r) => r.statusCode).join(',')})`);
  assert(results.slice(0, 4).map((r) => r.body?.attemptsLeft).join(',') === '4,3,2,1', `attempts left count down 4,3,2,1 (got ${results.map((r) => r.body?.attemptsLeft).join(',')})`);
  assert(/4 attempts left/.test(results[0].body?.error || ''), `first miss says "4 attempts left" ("${results[0].body?.error}")`);
  assert(/1 attempt left/.test(results[3].body?.error || ''), `fourth miss says "1 attempt left" ("${results[3].body?.error}")`);
  assert(results[4].statusCode === 429 && results[4].body?.locked === true, `fifth miss locks (got ${results[4].statusCode})`);
  assert(/locked for 60 minutes/.test(results[4].body?.error || ''), `lock message says 60 minutes ("${results[4].body?.error}")`);
  const r = mockRes(); await loginHandler(req({ email: EMAIL, password: PW }), r);
  assert(r.statusCode === 429 && /locked for (60|59) /.test(r.body?.error || ''), `right password is refused while locked, with the time left ("${r.body?.error}")`);
  assert(Number(r.headers['retry-after']) > 3500, 'Retry-After header is about an hour');

  console.log('\n[3] the lock is per email + IP: the owner on another device still gets in');
  const reqFrom = (ip, body) => ({ ...req(body), headers: { ...req(body).headers, 'x-forwarded-for': ip } });
  const r3 = mockRes(); await loginHandler(reqFrom(`198.18.78.${Math.floor(Math.random() * 200) + 10}`, { email: EMAIL, password: PW }), r3);
  assert(r3.statusCode === 200, `right password from a different IP → 200 while the attacker's IP is locked (${r3.statusCode})`);
  const r3b = mockRes(); await loginHandler(req({ email: EMAIL, password: PW }), r3b);
  assert(r3b.statusCode === 429, `the attacker's IP stays locked (${r3b.statusCode})`);

  console.log('\n[4] many failures for one email from many IPs: slowed, never locked');
  const EMAIL2 = `lockout2-${STAMP}@example.com`;
  await sql`INSERT INTO users (email, password_hash, name, email_verified_at) VALUES (${EMAIL2}, ${await hashPassword(PW)}, 'Lock Out Two', NOW())`;
  const spray = [];
  for (let i = 0; i < 10; i++) {
    const rr = mockRes();
    await loginHandler(reqFrom(`198.18.${80 + i}.${Math.floor(Math.random() * 200) + 10}`, { email: EMAIL2, password: 'wrong-' + i }), rr);
    spray.push(rr.statusCode);
  }
  assert(spray.every((c) => c === 401), `ten misses from ten IPs are all 401, none locks (${spray.join(',')})`);
  const t0 = Date.now();
  const r4 = mockRes(); await loginHandler(reqFrom(`198.18.99.${Math.floor(Math.random() * 200) + 10}`, { email: EMAIL2, password: PW }), r4);
  const took = Date.now() - t0;
  assert(r4.statusCode === 200, `the owner still signs in with the right password (${r4.statusCode})`);
  assert(took >= 1900, `the attempt was slowed by about two seconds (${took}ms)`);
  const t1 = Date.now();
  const r5 = mockRes(); await loginHandler(reqFrom(`198.18.99.${Math.floor(Math.random() * 200) + 10}`, { email: EMAIL2, password: PW }), r5);
  assert(r5.statusCode === 200 && Date.now() - t1 < 1500, `a successful sign-in clears the slow-down (${Date.now() - t1}ms)`);

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
run().catch((e) => { console.error('login-lockout test crashed:', e); process.exit(1); });
