// Passwordless QA dev-login (api/auth/dev-login.js). Confirms:
//   • OFF by default - 404 when DEV_LOGIN_SECRET is unset or too short.
//   • Wrong token → 404 (can't probe for existence).
//   • Correct token → creates the QA account, issues a session cookie,
//     302-redirects, and is idempotent (re-uses the same QA user).
//   • Each ?state= preset forces the expected subscription/onboarding shape
//     (paywall blocks, trial/active open, onboarding resets onboarded_at).
//   • Only the QA workspace is ever touched.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/dev-login.test.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { isWorkspaceActive } from '../api/_lib/clientPortal.js';
import devLogin from '../api/auth/dev-login.js';

const SECRET = 'qa-dev-login-secret-at-least-16-chars';
const QA_EMAIL = (process.env.QA_USER_EMAIL || 'qa@joinivy.ai').toLowerCase();

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

function mockRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    writeHead(c, h) { this.statusCode = c; if (h) for (const [k, v] of Object.entries(h)) this.setHeader(k, v); return this; },
    json(o) { this.body = o; return this; },
    end(s) { this.body = s ?? this.body; return this; },
  };
}
const req = (query = {}) => ({ method: 'GET', headers: {}, query });

async function wsRow() {
  const r = await sql`
    SELECT w.subscription_status, w.trial_ends_at, w.subscription_period_end,
           w.onboarded_at, u.walkthrough_completed_at, u.onboarding_state
      FROM workspaces w JOIN users u ON u.id = w.owner_id
     WHERE u.email = ${QA_EMAIL} LIMIT 1`;
  return r.rows[0];
}

async function run() {
  try {
    await ensureSchemaApplied();
    // Clean slate so idempotency/creation is deterministic.
    await sql`DELETE FROM workspaces WHERE owner_id IN (SELECT id FROM users WHERE email = ${QA_EMAIL})`;
    await sql`DELETE FROM users WHERE email = ${QA_EMAIL}`;

    console.log('\n[1] disabled when no secret set → 404');
    delete process.env.DEV_LOGIN_SECRET;
    let r = mockRes();
    await devLogin(req({ token: 'anything' }), r);
    assert(r.statusCode === 404, 'no secret → 404');

    console.log('\n[2] too-short secret stays disabled → 404');
    process.env.DEV_LOGIN_SECRET = 'short';
    r = mockRes();
    await devLogin(req({ token: 'short' }), r);
    assert(r.statusCode === 404, 'short secret → 404');

    // Enable for the rest.
    process.env.DEV_LOGIN_SECRET = SECRET;

    console.log('\n[3] wrong token → 404 (no account created)');
    r = mockRes();
    await devLogin(req({ token: 'nope-wrong-token-1234567' }), r);
    assert(r.statusCode === 404, 'wrong token → 404');
    const none = await sql`SELECT id FROM users WHERE email = ${QA_EMAIL}`;
    assert(none.rows.length === 0, 'no QA user created on a bad token');

    console.log('\n[4] correct token, no state → creates QA user, session cookie, 302');
    r = mockRes();
    await devLogin(req({ token: SECRET }), r);
    assert(r.statusCode === 302, 'redirects (302)');
    assert(r.getHeader('location') === '/', 'lands at app root');
    const cookie = r.getHeader('set-cookie');
    assert(typeof cookie === 'string' && cookie.startsWith('ivy_session='), 'sets ivy_session cookie');
    const created = await sql`SELECT id, user_type, email_verified_at FROM users WHERE email = ${QA_EMAIL}`;
    assert(created.rows.length === 1, 'QA user exists');
    assert(created.rows[0].user_type === 'regular', 'QA user is a plain owner (not admin)');
    assert(!!created.rows[0].email_verified_at, 'QA user email is pre-verified');
    const qaUserId = created.rows[0].id;

    console.log('\n[5] idempotent — second login re-uses the same QA user');
    r = mockRes();
    await devLogin(req({ token: SECRET }), r);
    const again = await sql`SELECT id FROM users WHERE email = ${QA_EMAIL}`;
    assert(again.rows.length === 1 && again.rows[0].id === qaUserId, 'still one QA user, same id');

    console.log('\n[6] state=paywall → onboarded + incomplete sub → blocked');
    r = mockRes();
    await devLogin(req({ token: SECRET, state: 'paywall' }), r);
    assert(r.getHeader('location') === '/', 'paywall lands at app root');
    let w = await wsRow();
    assert(w.subscription_status === 'incomplete', 'sub is incomplete');
    assert(!!w.onboarded_at, 'onboarded_at is set (so the wall, not onboarding, shows)');
    assert(isWorkspaceActive(w) === false, 'workspace is NOT active → hard paywall');

    console.log('\n[7] state=trial → trialing, active, 14 days out');
    r = mockRes();
    await devLogin(req({ token: SECRET, state: 'trial' }), r);
    w = await wsRow();
    assert(w.subscription_status === 'trialing', 'sub is trialing');
    assert(isWorkspaceActive(w) === true, 'trial workspace is active');
    const daysOut = (new Date(w.trial_ends_at).getTime() - Date.now()) / 86400000;
    assert(daysOut > 13 && daysOut <= 14, 'trial ends ~14 days out');

    console.log('\n[8] state=active → paying subscriber, active');
    r = mockRes();
    await devLogin(req({ token: SECRET, state: 'active' }), r);
    w = await wsRow();
    assert(w.subscription_status === 'active', 'sub is active');
    assert(isWorkspaceActive(w) === true, 'active workspace is active');

    console.log('\n[9] state=onboarding → resets onboarded_at + walkthrough, lands on /onboarding');
    r = mockRes();
    await devLogin(req({ token: SECRET, state: 'onboarding' }), r);
    assert(r.getHeader('location') === '/onboarding', 'lands on the onboarding wizard');
    w = await wsRow();
    assert(w.onboarded_at === null, 'onboarded_at cleared');
    assert(w.walkthrough_completed_at === null, 'walkthrough_completed_at cleared');
    assert(w.subscription_status === 'incomplete', 'sub reset to incomplete');

    console.log('\n[10] unknown state → 400');
    r = mockRes();
    await devLogin(req({ token: SECRET, state: 'bogus' }), r);
    assert(r.statusCode === 400, 'unknown state rejected');
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  } finally {
    await sql`DELETE FROM workspaces WHERE owner_id IN (SELECT id FROM users WHERE email = ${QA_EMAIL})`.catch(() => {});
    await sql`DELETE FROM users WHERE email = ${QA_EMAIL}`.catch(() => {});
    delete process.env.DEV_LOGIN_SECRET;
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
run();
