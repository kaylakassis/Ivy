// RevenueCat webhook: only events for a workspace the owner actually
// identified (POST /api/billing/iap-identify) or whose Apple original
// transaction we already know are applied. Sandbox events (TestFlight and
// App Review) apply only to a bound workspace, never stamp a paid
// conversion, and are ignored entirely with REVENUECAT_BLOCK_SANDBOX=1.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/revenuecat-binding.test.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';

const SECRET = 'rc_binding_test_secret_long_enough';
process.env.REVENUECAT_WEBHOOK_SECRET = SECRET;
delete process.env.REVENUECAT_BLOCK_SANDBOX;

const { default: rcHandler } = await import('../api/billing/revenuecat-webhook.js');
const { default: identifyHandler } = await import('../api/billing/iap-identify.js');

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

function mkRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(o) { this.body = o; return this; },
    end(s) { this.body = s; return this; },
  };
}
const rcReq = (event) => ({
  method: 'POST', url: '/api/billing/revenuecat-webhook', body: JSON.stringify({ event }),
  headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
});
const TAG = `rcb-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
let n = 0;
const evt = (type, wid, extra = {}) => ({
  id: `${TAG}-evt-${++n}`, type, app_user_id: wid, product_id: 'ivy_weekly',
  environment: 'PRODUCTION', expiration_at_ms: Date.now() + 7 * 86400000, ...extra,
});
const row = async (wid) => (await sql`SELECT subscription_status, subscription_source, revenuecat_user_id FROM workspaces WHERE id = ${wid}`).rows[0];
const unboundFailures = async () => (await sql`
  SELECT COUNT(*)::int AS c FROM webhook_failures
   WHERE source = 'revenuecat' AND event_type = 'unbound' AND message LIKE ${'%' + TAG + '%'}`).rows[0].c;

const users = [];
async function mkOwner(label) {
  const u = await sql`INSERT INTO users (email, password_hash, name, terms_version, terms_accepted_at)
    VALUES (${`${TAG}-${label}@test.local`}, 'x', ${label}, 'v1', NOW()) RETURNING id`;
  users.push(u.rows[0].id);
  const w = await sql`INSERT INTO workspaces (owner_id, subscription_status) VALUES (${u.rows[0].id}, 'incomplete') RETURNING id`;
  return { uid: u.rows[0].id, wid: w.rows[0].id, cookie: `ivy_session=${signSession(u.rows[0].id)}` };
}

try {
  await ensureSchemaApplied();
  const owner = await mkOwner('owner');
  const other = await mkOwner('other');

  console.log('\n[1] a sandbox event for an unbound workspace changes nothing');
  let r = mkRes();
  await rcHandler(rcReq(evt('INITIAL_PURCHASE', owner.wid, { environment: 'SANDBOX' })), r);
  assert(r.statusCode === 200 && r.body?.ignored === 'unbound app_user_id', `unbound SANDBOX → ignored (${JSON.stringify(r.body)})`);
  assert((await row(owner.wid)).subscription_status === 'incomplete', 'workspace untouched by a sandbox purchase');
  process.env.REVENUECAT_BLOCK_SANDBOX = '1';
  r = mkRes();
  await rcHandler(rcReq(evt('INITIAL_PURCHASE', owner.wid, { environment: 'SANDBOX' })), r);
  assert(r.body?.ignored === 'sandbox', `REVENUECAT_BLOCK_SANDBOX=1 → ignored:sandbox (${JSON.stringify(r.body)})`);
  delete process.env.REVENUECAT_BLOCK_SANDBOX;

  console.log('\n[2] an event for a workspace the owner never identified is ignored and recorded');
  const beforeFailures = await unboundFailures();
  r = mkRes();
  await rcHandler(rcReq(evt('INITIAL_PURCHASE', owner.wid)), r);
  assert(r.statusCode === 200 && r.body?.ignored === 'unbound app_user_id', `unbound → 200 ignored (${JSON.stringify(r.body)})`);
  assert((await row(owner.wid)).subscription_status === 'incomplete', 'subscription not flipped');
  assert((await unboundFailures()) === beforeFailures + 1, 'recorded as a webhook failure for ops');

  console.log('\n[3] iap-identify stamps the caller\'s own workspace only');
  r = mkRes();
  await identifyHandler({ method: 'POST', body: {}, headers: { host: 'localhost:3000', origin: 'http://localhost:3000' } }, r);
  assert(r.statusCode === 401, `unauthenticated → 401 (${r.statusCode})`);
  r = mkRes();
  await identifyHandler({ method: 'POST', body: { workspaceId: other.wid }, headers: { host: 'localhost:3000', origin: 'http://localhost:3000', cookie: owner.cookie } }, r);
  assert(r.statusCode === 200 && r.body?.appUserId === owner.wid, `owner identify → 200 with own workspace id (${JSON.stringify(r.body)})`);
  assert((await row(owner.wid)).revenuecat_user_id === owner.wid, 'revenuecat_user_id stamped on the owner workspace');
  assert((await row(other.wid)).revenuecat_user_id == null, 'a workspace id in the body is ignored (not stamped)');
  r = mkRes();
  await identifyHandler({ method: 'POST', body: {}, headers: { host: 'localhost:3000', origin: 'https://evil.example', cookie: owner.cookie } }, r);
  assert(r.statusCode === 403, `cross-site POST → 403 (${r.statusCode})`);

  console.log('\n[4] once identified, the same event applies');
  r = mkRes();
  await rcHandler(rcReq(evt('INITIAL_PURCHASE', owner.wid, { period_type: 'NORMAL', original_transaction_id: `${TAG}-txn` })), r);
  assert(r.statusCode === 200 && r.body?.status === 'active', `bound → applied (${JSON.stringify(r.body)})`);
  const s = await row(owner.wid);
  assert(s.subscription_status === 'active' && s.subscription_source === 'apple', 'workspace active on Apple');

  console.log('\n[4b] the App Store build (no identify call) binds through /api/me from the app');
  const { default: meHandler } = await import('../api/me/index.js');
  const legacy = await mkOwner('legacy-app');
  r = mkRes();
  await meHandler({ method: 'GET', query: {}, headers: { host: 'localhost:3000', cookie: legacy.cookie } }, r);
  assert((await row(legacy.wid)).revenuecat_user_id === null, 'web /api/me does not stamp');
  r = mkRes();
  await meHandler({ method: 'GET', query: {}, headers: { host: 'localhost:3000', cookie: legacy.cookie, 'x-client-platform': 'ios' } }, r);
  assert(r.statusCode === 200 && (await row(legacy.wid)).revenuecat_user_id === legacy.wid, 'native /api/me stamps the owner\'s own workspace');
  r = mkRes();
  await rcHandler(rcReq(evt('INITIAL_PURCHASE', legacy.wid, { period_type: 'NORMAL', original_transaction_id: `${TAG}-legacy` })), r);
  assert(r.statusCode === 200 && r.body?.status === 'active', `legacy-app purchase applies (${JSON.stringify(r.body)})`);

  console.log('\n[5] a known Apple original_transaction_id also binds (identify stamp missing)');
  await sql`UPDATE workspaces SET revenuecat_user_id = NULL, apple_original_transaction_id = ${`${TAG}-txn2`} WHERE id = ${other.wid}`;
  r = mkRes();
  await rcHandler(rcReq(evt('RENEWAL', other.wid, { original_transaction_id: 'someone-elses-txn' })), r);
  assert(r.body?.ignored === 'unbound app_user_id', 'different transaction id → ignored');
  r = mkRes();
  await rcHandler(rcReq(evt('RENEWAL', other.wid, { original_transaction_id: `${TAG}-txn2` })), r);
  assert(r.body?.status === 'active' && (await row(other.wid)).subscription_status === 'active', 'matching transaction id → applied');

  console.log('\n[6] App Review: a sandbox purchase unlocks a bound workspace but is never a paid conversion');
  const reviewer = await mkOwner('reviewer');
  await sql`UPDATE workspaces SET revenuecat_user_id = ${reviewer.wid} WHERE id = ${reviewer.wid}`;
  r = mkRes();
  await rcHandler(rcReq(evt('INITIAL_PURCHASE', reviewer.wid, { environment: 'SANDBOX', period_type: 'NORMAL' })), r);
  assert(r.body?.status === 'active' && (await row(reviewer.wid)).subscription_status === 'active', `bound sandbox purchase unlocks (${JSON.stringify(r.body)})`);
  const conv = (await sql`SELECT converted_at FROM workspaces WHERE id = ${reviewer.wid}`).rows[0].converted_at;
  assert(conv === null, 'sandbox purchase does not stamp converted_at');
} catch (err) {
  console.error('Fatal:', err.message, err.stack);
  fail++;
} finally {
  await sql`DELETE FROM webhook_failures WHERE source = 'revenuecat' AND message LIKE ${'%' + TAG + '%'}`.catch(() => {});
  await sql`DELETE FROM webhook_event_dedup WHERE provider = 'revenuecat' AND event_id LIKE ${TAG + '%'}`.catch(() => {});
  for (const uid of users) {
    await sql`DELETE FROM workspaces WHERE owner_id = ${uid}`.catch(() => {});
    await sql`DELETE FROM users WHERE id = ${uid}`.catch(() => {});
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
