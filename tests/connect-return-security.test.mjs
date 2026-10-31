// Payment-processor connect callbacks are bound to the owner who started
// them.
//
//   PayPal (api/finance/paypal-onboard-callback.js): the init ALWAYS mints
//   a signed state. The callback refuses without it, refuses a state for a
//   different workspace/user than the session, and refuses a merchant whose
//   PayPal tracking_id is not this workspace. Seller-status lookup failing
//   is fail-closed (nothing persisted).
//
//   Square (api/finance/square-oauth-callback.js): the web flow needs the
//   sq_state nonce cookie the init dropped, hashed into the state JWT.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/connect-return-security.test.mjs

import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import { signReturnState, SQ_STATE_COOKIE } from '../api/_lib/connectReturn.js';

process.env.PAYPAL_CLIENT_ID = 'pp_client_test';
process.env.PAYPAL_CLIENT_SECRET = 'pp_secret_test';
process.env.PAYPAL_PARTNER_ID = 'PARTNER_TEST';
process.env.SQUARE_APPLICATION_ID = 'sq0idp-test';
process.env.SQUARE_APPLICATION_SECRET = 'sq0csp-test';

const { default: paypalInit } = await import('../api/finance/paypal-onboard-init.js');
const { default: paypalCallback } = await import('../api/finance/paypal-onboard-callback.js');
const { default: squareInit } = await import('../api/finance/square-oauth-init.js');
const { default: squareCallback } = await import('../api/finance/square-oauth-callback.js');

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

function mkRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    writeHead(c, h) { this.statusCode = c; for (const [k, v] of Object.entries(h || {})) this.headers[k.toLowerCase()] = v; return this; },
    json(o) { this.body = o; return this; },
    end(s) { if (s !== undefined) this.body = s; return this; },
  };
}
function req({ method = 'GET', query = {}, cookie, headers = {} } = {}) {
  return {
    method, query, body: {},
    headers: { host: 'localhost:3000', ...(cookie ? { cookie } : {}), ...headers },
  };
}
const location = (r) => r.headers.location || '';

// ── fetch mock: PayPal token mint, partner-referral, merchant-integrations ──
let sellerStatusResponse = null; // null → 502 from PayPal
let sellerStatusCalls = 0;
let referralReturnUrl = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('/v1/oauth2/token')) {
    return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
  }
  if (u.includes('/v2/customer/partner-referrals')) {
    const body = JSON.parse(opts.body);
    referralReturnUrl = body.partner_config_override?.return_url;
    return new Response(JSON.stringify({ links: [{ rel: 'action_url', href: 'https://www.sandbox.paypal.com/onboard?token=x' }] }), { status: 200 });
  }
  if (u.includes('/merchant-integrations/')) {
    sellerStatusCalls++;
    if (!sellerStatusResponse) return new Response('upstream down', { status: 502 });
    return new Response(JSON.stringify(sellerStatusResponse), { status: 200 });
  }
  return realFetch(url, opts);
};

const TAG = `crs-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const created = { users: [] };
async function mkOwner(label) {
  const u = await sql`
    INSERT INTO users (email, password_hash, name, terms_version, terms_accepted_at, email_verified_at)
    VALUES (${`${TAG}-${label}@test.local`}, 'x', ${label}, 'v1', NOW(), NOW()) RETURNING id`;
  const uid = u.rows[0].id;
  created.users.push(uid);
  const w = await sql`
    INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, onboarded_at)
    VALUES (${uid}, ${`WS ${label}`}, 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`;
  return { uid, wid: w.rows[0].id, cookie: `ivy_session=${signSession(uid)}` };
}
async function paypalMerchant(wid) {
  const r = await sql`SELECT paypal_merchant_id FROM finance_settings WHERE workspace_id = ${wid}`;
  return r.rows[0]?.paypal_merchant_id || null;
}

try {
  await ensureSchemaApplied();
  const victim = await mkOwner('victim');
  const attacker = await mkOwner('attacker');
  const ATTACKER_MERCHANT = 'ATTACKERMERCH1';
  const VICTIM_MERCHANT = 'VICTIMMERCH1';

  console.log('\n[1] PayPal init puts a signed state in the return URL for the WEB flow too');
  let r = mkRes();
  await paypalInit(req({ cookie: victim.cookie }), r);
  assert(r.statusCode === 302 && location(r).startsWith('https://www.sandbox.paypal.com/'), `init redirects to PayPal (got ${r.statusCode} ${location(r)})`);
  const ret = new URL(referralReturnUrl);
  const webState = ret.searchParams.get('state');
  assert(!!webState && ret.searchParams.get('from') === 'web', 'return_url carries state + from=web');
  assert(!ret.searchParams.has('wid'), 'return_url no longer carries a bare wid');
  const decoded = jwt.verify(webState, process.env.JWT_SECRET);
  assert(decoded.wid === victim.wid && decoded.uid === victim.uid && decoded.kind === 'paypal_return' && decoded.from === 'web', 'state names the owner, workspace, flow and surface');

  console.log('\n[2] PayPal callback WITHOUT state (the attacker-mailed link) never persists');
  sellerStatusResponse = { merchant_id: ATTACKER_MERCHANT, tracking_id: attacker.wid, payments_receivable: true, legal_name: 'Evil LLC' };
  r = mkRes();
  await paypalCallback(req({ cookie: victim.cookie, query: { merchantIdInPayPal: ATTACKER_MERCHANT, permissionsGranted: 'true', wid: victim.wid } }), r);
  assert(r.statusCode === 302 && /paypal=error/.test(location(r)), `no state → redirect with paypal=error (${location(r)})`);
  assert((await paypalMerchant(victim.wid)) === null, 'nothing persisted for the victim workspace');

  console.log('\n[3] PayPal callback with a state minted for ANOTHER workspace/user is refused');
  const attackerState = signReturnState({ workspaceId: attacker.wid, userId: attacker.uid, kind: 'paypal_return', from: 'web' });
  r = mkRes();
  await paypalCallback(req({ cookie: victim.cookie, query: { merchantIdInPayPal: ATTACKER_MERCHANT, permissionsGranted: 'true', state: attackerState, from: 'web' } }), r);
  assert(r.statusCode === 302 && /paypal=error/.test(location(r)) && /different\+account|different%20account/i.test(location(r)), `mismatched state → paypal=error (${location(r)})`);
  assert((await paypalMerchant(victim.wid)) === null, 'still nothing persisted for the victim');

  console.log('\n[4] matching state but PayPal tracking_id names another workspace → refused');
  const victimState = signReturnState({ workspaceId: victim.wid, userId: victim.uid, kind: 'paypal_return', from: 'web' });
  r = mkRes();
  await paypalCallback(req({ cookie: victim.cookie, query: { merchantIdInPayPal: ATTACKER_MERCHANT, permissionsGranted: 'true', state: victimState, from: 'web' } }), r);
  assert(r.statusCode === 302 && /paypal=error/.test(location(r)), `tracking_id mismatch → paypal=error (${location(r)})`);
  assert((await paypalMerchant(victim.wid)) === null, "attacker's merchant not attached even with the victim's own state");

  console.log('\n[5] seller status lookup failing is fail-closed');
  sellerStatusResponse = null;
  const callsBefore = sellerStatusCalls;
  r = mkRes();
  await paypalCallback(req({ cookie: victim.cookie, query: { merchantIdInPayPal: VICTIM_MERCHANT, permissionsGranted: 'true', state: victimState, from: 'web' } }), r);
  assert(sellerStatusCalls === callsBefore + 1, 'seller status was asked for');
  assert(r.statusCode === 302 && /paypal=error/.test(location(r)) && /try\+connecting\+again|try%20connecting%20again/i.test(location(r)), `PayPal down → error asking the owner to retry (${location(r)})`);
  assert((await paypalMerchant(victim.wid)) === null, 'not persisted when PayPal could not confirm');

  console.log('\n[6] matching state + session + tracking_id → connected');
  sellerStatusResponse = { merchant_id: VICTIM_MERCHANT, tracking_id: victim.wid, payments_receivable: true, legal_name: 'Victim Studio' };
  r = mkRes();
  await paypalCallback(req({ cookie: victim.cookie, query: { merchantIdInPayPal: VICTIM_MERCHANT, permissionsGranted: 'true', state: victimState, from: 'web' } }), r);
  assert(r.statusCode === 302 && /paypal=connected/.test(location(r)), `legit flow → paypal=connected (${location(r)})`);
  assert((await paypalMerchant(victim.wid)) === VICTIM_MERCHANT, 'merchant persisted for the right workspace');

  console.log('\n[7] app flow: state is the credential, tracking_id still checked, lands on /connected');
  const appState = signReturnState({ workspaceId: attacker.wid, userId: attacker.uid, kind: 'paypal_return', from: 'app' });
  r = mkRes();
  await paypalCallback(req({ query: { merchantIdInPayPal: VICTIM_MERCHANT, permissionsGranted: 'true', state: appState, from: 'app' } }), r);
  assert(r.statusCode === 302 && /\/connected\?paypal=error/.test(location(r)), `app state + foreign merchant → /connected?paypal=error (${location(r)})`);
  assert((await paypalMerchant(attacker.wid)) === null, "victim's merchant not attached to the attacker workspace");
  sellerStatusResponse = { merchant_id: ATTACKER_MERCHANT, tracking_id: attacker.wid, payments_receivable: false };
  r = mkRes();
  await paypalCallback(req({ query: { merchantIdInPayPal: ATTACKER_MERCHANT, permissionsGranted: 'true', state: appState, from: 'app' } }), r);
  assert(r.statusCode === 302 && /\/connected\?paypal=connected/.test(location(r)), `app flow with own merchant → /connected?paypal=connected (${location(r)})`);

  console.log('\n[8] Square init (web) sets the sq_state cookie and seals its hash in the state');
  r = mkRes();
  await squareInit(req({ cookie: victim.cookie }), r);
  assert(r.statusCode === 302 && /oauth2\/authorize/.test(location(r)), `square init redirects to Square (${r.statusCode})`);
  const setCookie = String(r.headers['set-cookie'] || '');
  const nonce = /sq_state=([^;]+)/.exec(setCookie)?.[1];
  assert(!!nonce && /HttpOnly/i.test(setCookie) && /Secure/i.test(setCookie) && /SameSite=Lax/i.test(setCookie), `sq_state cookie set HttpOnly+Secure+Lax (${setCookie.slice(0, 60)})`);
  const sqState = new URL(location(r)).searchParams.get('state');
  const sqPayload = jwt.verify(sqState, process.env.JWT_SECRET);
  assert(sqPayload.nonce === crypto.createHash('sha256').update(nonce).digest('hex'), 'state carries sha256(nonce)');
  assert(sqPayload.wid === victim.wid && sqPayload.uid === victim.uid, 'state names the owner and workspace');

  console.log('\n[9] Square callback (web) without the nonce cookie is rejected before any token exchange');
  const exchangeCalls = { n: 0 };
  globalThis.fetch = (((inner) => async (url, opts) => {
    if (String(url).includes('/oauth2/token')) { exchangeCalls.n++; return new Response('{}', { status: 500 }); }
    return inner(url, opts);
  })(globalThis.fetch));
  r = mkRes();
  await squareCallback(req({ cookie: victim.cookie, query: { code: 'sq_code', state: sqState } }), r);
  assert(r.statusCode === 302 && /square=error/.test(location(r)) && /this\+browser|this%20browser/i.test(location(r)), `no nonce cookie → square=error (${location(r)})`);
  assert(exchangeCalls.n === 0, 'Square token exchange never attempted');
  assert(/sq_state=;/.test(String(r.headers['set-cookie'] || '')) && /Max-Age=0/i.test(String(r.headers['set-cookie'] || '')), 'callback clears the nonce cookie');

  console.log('\n[10] Square callback with the WRONG nonce cookie is rejected; another signed-in user is rejected');
  r = mkRes();
  await squareCallback(req({ cookie: `${victim.cookie}; ${SQ_STATE_COOKIE}=not-the-nonce`, query: { code: 'sq_code', state: sqState } }), r);
  assert(r.statusCode === 302 && /square=error/.test(location(r)), `wrong nonce → square=error (${location(r)})`);
  r = mkRes();
  await squareCallback(req({ cookie: `${attacker.cookie}; ${SQ_STATE_COOKIE}=${nonce}`, query: { code: 'sq_code', state: sqState } }), r);
  assert(r.statusCode === 302 && /square=error/.test(location(r)) && /different\+account|different%20account/i.test(location(r)), `other user's session → square=error (${location(r)})`);
  assert(exchangeCalls.n === 0, 'still no token exchange');

  console.log('\n[11] Square callback with the matching nonce cookie proceeds to the token exchange');
  r = mkRes();
  await squareCallback(req({ cookie: `${victim.cookie}; ${SQ_STATE_COOKIE}=${nonce}`, query: { code: 'sq_code', state: sqState } }), r);
  assert(exchangeCalls.n === 1, 'token exchange reached with cookie + state matching');

  console.log('\n[12] Square app flow: no cookie needed, but a state without from=app and without nonce is refused');
  const bareState = jwt.sign({ wid: victim.wid, uid: victim.uid, kind: 'square_oauth' }, process.env.JWT_SECRET, { expiresIn: '15m', algorithm: 'HS256' });
  r = mkRes();
  await squareCallback(req({ cookie: victim.cookie, query: { code: 'sq_code', state: bareState } }), r);
  assert(r.statusCode === 302 && /square=error/.test(location(r)) && exchangeCalls.n === 1, 'nonce-less web state refused');
  const appSq = jwt.sign({ wid: victim.wid, uid: victim.uid, kind: 'square_oauth', from: 'app' }, process.env.JWT_SECRET, { expiresIn: '15m', algorithm: 'HS256' });
  r = mkRes();
  await squareCallback(req({ query: { code: 'sq_code', state: appSq } }), r);
  assert(exchangeCalls.n === 2 && /\/connected\?square=/.test(location(r)), `app state without a session reaches the exchange and lands on /connected (${location(r)})`);
} catch (err) {
  console.error('Fatal:', err.message, err.stack);
  fail++;
} finally {
  globalThis.fetch = realFetch;
  for (const uid of created.users) {
    await sql`DELETE FROM finance_settings WHERE workspace_id IN (SELECT id FROM workspaces WHERE owner_id = ${uid})`.catch(() => {});
    await sql`DELETE FROM workspaces WHERE owner_id = ${uid}`.catch(() => {});
    await sql`DELETE FROM users WHERE id = ${uid}`.catch(() => {});
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
