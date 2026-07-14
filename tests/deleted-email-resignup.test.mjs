// A deleted account must never squat its email. Deletion paths mangle the
// address to free it, but a legacy or partially-failed delete can leave a
// soft-deleted row holding the original email - and signup used to answer
// "Email already in use" for that ghost. Signup now self-heals: if the
// squatting row is soft-deleted, its email is mangled inline and the new
// signup proceeds. Live accounts are still protected.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/deleted-email-resignup.test.mjs
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { CURRENT_TERMS_VERSION, CURRENT_PRIVACY_VERSION } from '../api/_lib/legal.js';
import signupHandler from '../api/auth/signup.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

let ipCounter = 0;
const nextIp = () => `198.51.100.${30 + (++ipCounter % 200)}`;

function makeRes() {
  return {
    statusCode: 200, headers: {}, body: null,
    setHeader(k, v) {
      const key = k.toLowerCase();
      if (key === 'set-cookie') { (this.headers[key] ||= []).push(v); }
      else this.headers[key] = v;
    },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    writeHead(c, h) { this.statusCode = c; if (h) for (const [k, v] of Object.entries(h)) this.setHeader(k, v); },
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
      origin: 'http://localhost:3000',
      host: 'localhost:3000',
      'x-forwarded-for': nextIp(),
    },
  };
}
const signupBody = (email, name) => ({
  email, name, password: 'sufficiently-long-pass-123',
  acceptedTermsVersion: CURRENT_TERMS_VERSION,
  acceptedPrivacyVersion: CURRENT_PRIVACY_VERSION,
});

const EMAIL = `resignup-ghost-${Date.now()}@example.com`;
const EMAIL_LIVE = `resignup-live-${Date.now()}@example.com`;

async function cleanup() {
  for (const pat of [`resignup-ghost-%`, `resignup-live-%`]) {
    const { rows } = await sql.query(
      `SELECT id FROM users WHERE email LIKE '${pat}' OR email LIKE '%+deleted-%'`);
    for (const r of rows) {
      await sql`DELETE FROM workspaces WHERE owner_id = ${r.id}`.catch(() => {});
      await sql`DELETE FROM users WHERE id = ${r.id}`.catch(() => {});
    }
  }
}

async function run() {
  try {
    await ensureSchemaApplied();

    console.log('\n[1] first signup succeeds');
    let res = makeRes();
    await signupHandler(makeReq(signupBody(EMAIL, 'Ghost One')), res);
    assert(res.statusCode === 201 || res.statusCode === 200, `first signup OK (got ${res.statusCode})`);
    const firstId = res.body?.user?.id;

    console.log('\n[2] stuck ghost: soft-deleted WITHOUT the email mangle');
    await sql`UPDATE users SET deleted_at = NOW() WHERE id = ${firstId}`;

    console.log('\n[3] re-signup with the same email self-heals and succeeds');
    res = makeRes();
    await signupHandler(makeReq(signupBody(EMAIL, 'Ghost Two')), res);
    assert(res.statusCode === 201 || res.statusCode === 200,
      `re-signup succeeded instead of "already in use" (got ${res.statusCode}: ${JSON.stringify(res.body?.error || '')})`);
    const secondId = res.body?.user?.id;
    assert(secondId && secondId !== firstId, 'a brand-new user row was created');

    const ghost = (await sql`SELECT email, deleted_at FROM users WHERE id = ${firstId}`).rows[0];
    assert(ghost && /\+deleted-/.test(ghost.email), `ghost row's email was mangled (${ghost?.email})`);
    const owner = (await sql`SELECT id FROM users WHERE email = ${EMAIL}`).rows[0];
    assert(owner?.id === secondId, 'the new user now owns the original email');

    console.log('\n[4] a LIVE account still blocks its email');
    res = makeRes();
    await signupHandler(makeReq(signupBody(EMAIL_LIVE, 'Live A')), res);
    assert(res.statusCode === 201 || res.statusCode === 200, 'live account created');
    res = makeRes();
    await signupHandler(makeReq(signupBody(EMAIL_LIVE, 'Live B')), res);
    assert(res.statusCode === 400, `duplicate live email still 400s (got ${res.statusCode})`);
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  } finally {
    await cleanup();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run();
