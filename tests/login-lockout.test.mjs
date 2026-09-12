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

  console.log('\n[2] five wrong passwords lock the email; the message says how long');
  codes = [];
  let last;
  for (let i = 0; i < 6; i++) { const r = mockRes(); await loginHandler(req({ email: EMAIL, password: 'nope-' + i }), r); codes.push(r.statusCode); last = r; }
  assert(codes.slice(0, 5).every((c) => c === 401), `first five are 401 (got ${codes.slice(0, 5).join(',')})`);
  assert(codes[5] === 429, `sixth is 429 (got ${codes[5]})`);
  assert(/hour/.test(last.body?.error || ''), `message says to wait about an hour ("${last.body?.error}")`);
  const r = mockRes(); await loginHandler(req({ email: EMAIL, password: PW }), r);
  assert(r.statusCode === 429, 'even the right password waits out the lock (429)');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
run().catch((e) => { console.error('login-lockout test crashed:', e); process.exit(1); });
