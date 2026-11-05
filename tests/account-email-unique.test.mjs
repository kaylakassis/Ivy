// One account per email address, whatever the capitals or stray spaces.
//
// users.email was UNIQUE but case-sensitive, so "Irene@x.com" and
// "irene@x.com" could be two accounts, and signup / login / password reset
// each lowercased (or not) on their own. Now every path normalises with
// normalizeAccountEmail (trim + lowercase), lookups are LOWER(email), and a
// unique index on LOWER(email) backs it up. Two signups racing for the same
// address give exactly one account and a friendly "already exists", never a
// 500.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/account-email-unique.test.mjs
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { CURRENT_TERMS_VERSION, CURRENT_PRIVACY_VERSION } from '../api/_lib/legal.js';
import { normalizeAccountEmail, isUniqueViolation, ACCOUNT_EXISTS_MESSAGE } from '../api/_lib/auth.js';
import signupHandler from '../api/auth/signup.js';
import loginHandler from '../api/auth/login.js';
import forgotHandler from '../api/auth/forgot-password.js';
import { KIND_RESET } from '../api/_lib/tokens.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

// Global outbound mute: welcome / verification / reset emails.
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ id: 'x' }), text: async () => '{}' });

const TAG = `emailuniq${Date.now()}${Math.floor(Math.random() * 1e4)}`;
let ipCounter = 0;
const nextIp = () => `203.0.113.${10 + (++ipCounter % 200)}`;

function makeRes() {
  return {
    statusCode: 200, headers: {}, body: null,
    setHeader(k, v) {
      const key = k.toLowerCase();
      if (key === 'set-cookie') { (this.headers[key] ||= []).push(v); } else this.headers[key] = v;
    },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
    end(s) { this.body = s; return this; },
  };
}
function makeReq(body) {
  return {
    method: 'POST', url: '/test', query: {}, body,
    headers: {
      'content-type': 'application/json',
      origin: 'http://localhost:3000', host: 'localhost:3000',
      'x-forwarded-for': nextIp(),
    },
  };
}
const PASSWORD = 'sufficiently-long-pass-123';
const signupBody = (email, name = 'Irene Test') => ({
  email, name, password: PASSWORD,
  acceptedTermsVersion: CURRENT_TERMS_VERSION,
  acceptedPrivacyVersion: CURRENT_PRIVACY_VERSION,
});
const call = async (handler, body) => { const r = makeRes(); await handler(makeReq(body), r); return r; };
const accountsFor = async (email) =>
  (await sql`SELECT id, email FROM users WHERE LOWER(email) = ${email.toLowerCase()}`).rows;

async function cleanup() {
  const { rows } = await sql.query(`SELECT id FROM users WHERE LOWER(email) LIKE $1`, [`%${TAG}%`]);
  for (const r of rows) {
    await sql`DELETE FROM workspaces WHERE owner_id = ${r.id}`.catch(() => {});
    await sql`DELETE FROM users WHERE id = ${r.id}`.catch(() => {});
  }
  await sql.query(`DELETE FROM rate_limits WHERE key LIKE $1`, [`%${TAG}%`]).catch(() => {});
}

async function run() {
  try {
    await ensureSchemaApplied();
    await cleanup();

    console.log('\n[0] normalisation helper');
    assert(normalizeAccountEmail('  Irene@Example.COM ') === 'irene@example.com', 'trim + lowercase');
    assert(normalizeAccountEmail(null) === '' && normalizeAccountEmail(42) === '', 'non-strings become empty');
    assert(normalizeAccountEmail('i.r.e.n.e+work@gmail.com') === 'i.r.e.n.e+work@gmail.com', 'Gmail dots and +aliases are kept (distinct addresses)');
    assert(normalizeAccountEmail('a'.repeat(400) + '@x.com').length === 254, 'capped at 254 characters');

    console.log('\n[1] signup stores the normalised address');
    const mixed = `  Irene.${TAG}@Example.COM `;
    const canonical = `irene.${TAG}@example.com`;
    let r = await call(signupHandler, signupBody(mixed));
    assert(r.statusCode === 201, `mixed-case signup with spaces accepted (got ${r.statusCode} ${JSON.stringify(r.body?.error || '')})`);
    let rows = await accountsFor(canonical);
    assert(rows.length === 1 && rows[0].email === canonical, `stored as "${rows[0]?.email}"`);

    console.log('\n[2] case-variant signups are refused');
    for (const variant of [canonical, canonical.toUpperCase(), ` Irene.${TAG}@example.com`]) {
      r = await call(signupHandler, signupBody(variant));
      assert(r.statusCode === 400 && r.body?.error === ACCOUNT_EXISTS_MESSAGE && r.body?.details?.code === 'email_taken',
        `"${variant.trim().slice(0, 40)}…" refused with the friendly message (got ${r.statusCode})`);
    }
    rows = await accountsFor(canonical);
    assert(rows.length === 1, 'still exactly one account');

    console.log('\n[3] the database refuses a case variant on its own');
    const idx = await sql`SELECT 1 FROM pg_indexes WHERE tablename = 'users' AND indexname = 'uq_users_email_lower'`;
    assert(idx.rows.length === 1, 'unique index on LOWER(email) exists');
    let dbErr = null;
    try {
      await sql`INSERT INTO users (email, password_hash, name) VALUES (${canonical.toUpperCase()}, 'x', 'Raw')`;
    } catch (e) { dbErr = e; }
    assert(dbErr && isUniqueViolation(dbErr), `raw INSERT of the upper-case variant fails with a unique violation (${dbErr?.code})`);

    console.log('\n[4] parallel signups for one new address: one account, no 500');
    const racer = `Race.${TAG}@Example.com`;
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) =>
      call(signupHandler, signupBody(i % 2 ? racer.toLowerCase() : racer, `Racer ${i}`))));
    const codes = results.map((x) => x.statusCode);
    assert(codes.filter((c) => c === 201).length === 1, `exactly one 201 (${codes.join(',')})`);
    assert(codes.filter((c) => c === 400).length === 5, 'the other five get 400');
    assert(!codes.some((c) => c >= 500), 'no 500s');
    assert(results.filter((x) => x.statusCode === 400).every((x) => x.body?.error === ACCOUNT_EXISTS_MESSAGE),
      'losers see "An account with this email already exists"');
    const raceRows = await accountsFor(racer);
    assert(raceRows.length === 1, 'one user row');
    const ws = await sql`SELECT COUNT(*)::int AS n FROM workspaces WHERE owner_id = ${raceRows[0]?.id}`;
    assert(ws.rows[0].n === 1, 'and one business');

    console.log('\n[5] sign-in works with any capitals or spaces');
    for (const typed of [canonical, canonical.toUpperCase(), `  Irene.${TAG}@EXAMPLE.com  `]) {
      r = await call(loginHandler, { email: typed, password: PASSWORD });
      assert(r.statusCode === 200 && r.body?.user?.email === canonical, `login as "${typed.trim().slice(0, 30)}…" → 200 (got ${r.statusCode} ${r.body?.error || ''})`);
    }
    r = await call(loginHandler, { email: canonical.toUpperCase(), password: 'wrong-password-123' });
    assert(r.statusCode === 401, 'wrong password still refused');

    console.log('\n[6] a legacy mixed-case row is still found (login + reset)');
    // Simulate a row stored before normalisation (the migration lowercases
    // these; one that could not be lowercased stays as it was).
    const legacyCanonical = `legacy.${TAG}@example.com`;
    r = await call(signupHandler, signupBody(legacyCanonical, 'Legacy Owner'));
    const legacyId = r.body?.user?.id;
    await sql`UPDATE users SET email = ${`Legacy.${TAG}@Example.com`} WHERE id = ${legacyId}`;
    r = await call(loginHandler, { email: legacyCanonical, password: PASSWORD });
    assert(r.statusCode === 200 && r.body?.user?.id === legacyId, `lowercase login finds the mixed-case row (got ${r.statusCode})`);
    r = await call(signupHandler, signupBody(legacyCanonical));
    assert(r.statusCode === 400 && r.body?.details?.code === 'email_taken', 'signup cannot create a lowercase twin of it');
    const before = await sql`SELECT COUNT(*)::int AS n FROM auth_tokens WHERE user_id = ${legacyId} AND kind = ${KIND_RESET}`;
    r = await call(forgotHandler, { email: `  LEGACY.${TAG}@EXAMPLE.COM ` });
    const after = await sql`SELECT COUNT(*)::int AS n FROM auth_tokens WHERE user_id = ${legacyId} AND kind = ${KIND_RESET}`;
    assert(r.statusCode === 200 && after.rows[0].n === before.rows[0].n + 1, 'password reset with different capitals issues a reset link');
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  } finally {
    await cleanup().catch(() => {});
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run();
