// Connecting Stripe from the iOS app.
//   1. The app asks /api/finance/stripe-oauth-init?mode=json&from=app with
//      its Bearer token and gets the onboarding URL as JSON (no 302, no
//      cookie needed). The return URL carries a signed state.
//   2. Stripe sends Safari (no Ivy session) to the callback with that state;
//      the callback finishes the connection and lands on /connected.
// Stripe itself is stubbed at the network.
// Run: node --import ./tests/bootstrap.mjs ./tests/stripe-connect-native.test.mjs
process.env.STRIPE_SECRET_KEY ||= 'sk_test_stub';
process.env.APP_URL ||= 'https://www.joinivy.ai';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import initHandler from '../api/finance/stripe-oauth-init.js';
import callbackHandler from '../api/finance/stripe-oauth-callback.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
const stripeCalls = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const body = init.body ? init.body.toString() : '';
  stripeCalls.push({ url: u, method: init.method || 'GET', body });
  const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
  if (/\/v1\/account_links$/.test(u)) return json({ object: 'account_link', url: 'https://connect.stripe.com/setup/e/acct_test/stub' });
  if (/\/v1\/accounts$/.test(u)) return json({ id: 'acct_test123', object: 'account' });
  if (/\/v1\/account$/.test(u)) return json({ id: 'acct_test123', charges_enabled: true, details_submitted: true, payouts_enabled: true, livemode: false, business_profile: { name: 'Kay Studio' }, email: 'k@example.com', settings: { dashboard: { display_name: 'Kay Studio' } } });
  return json({});
};
function mockRes() {
  return { statusCode: 200, headers: {}, body: undefined, ended: false,
    status(c) { this.statusCode = c; return this; }, setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; }, json(o) { this.body = o; return this; },
    writeHead(c, h) { this.statusCode = c; for (const [k, v] of Object.entries(h || {})) this.headers[k.toLowerCase()] = v; return this; },
    end(s) { this.ended = true; if (s !== undefined) this.body = s; return this; } };
}
const req = ({ query = {}, headers = {} } = {}) => ({ method: 'GET', url: '/t', query, body: {},
  headers: { host: 'www.joinivy.ai', 'user-agent': 'test', 'x-forwarded-for': '198.18.9.9', ...headers } });

async function run() {
  await ensureSchemaApplied();
  const S = Date.now();
  const u = await sql`INSERT INTO users (email, password_hash, name, email_verified_at) VALUES (${`stripe-native-${S}@example.com`}, 'x', 'Owner', NOW()) RETURNING id`;
  const uid = u.rows[0].id;
  const w = await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, onboarded_at) VALUES (${uid}, 'WS', 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`;
  const wsId = w.rows[0].id;
  const bearer = { authorization: `Bearer ${signSession(uid)}`, 'x-client-platform': 'ios' };

  console.log('\n[1] the app gets the onboarding link as JSON');
  let r = mockRes();
  await initHandler(req({ query: { mode: 'json', from: 'app' }, headers: bearer }), r);
  assert(r.statusCode === 200 && /^https:\/\/connect\.stripe\.com\//.test(r.body?.url || ''), `200 with a Stripe URL (got ${r.statusCode}: ${JSON.stringify(r.body).slice(0, 100)})`);
  const linkCall = stripeCalls.find((c) => /account_links$/.test(c.url));
  const params = new URLSearchParams(linkCall?.body || '');
  const returnUrl = params.get('return_url') || '';
  assert(/from=app&state=/.test(returnUrl), 'return URL carries from=app and a signed state');
  const state = new URL(returnUrl).searchParams.get('state');
  const acct = (await sql`SELECT stripe_connect_user_id FROM finance_settings WHERE workspace_id = ${wsId}`).rows[0]?.stripe_connect_user_id;
  assert(acct === 'acct_test123', 'connected account id persisted');

  console.log('\n[2] a plain web click (cookie, no mode) still redirects like before');
  r = mockRes();
  await initHandler(req({ headers: { cookie: `ivy_session=${signSession(uid)}` } }), r);
  assert(r.statusCode === 302 && /connect\.stripe\.com/.test(r.headers.location || ''), `302 to Stripe (got ${r.statusCode})`);

  console.log('\n[3] Stripe returns Safari with the state and no session: connection completes');
  r = mockRes();
  await callbackHandler(req({ query: { from: 'app', state } }), r);
  assert(r.statusCode === 302, `302 (got ${r.statusCode})`);
  assert(/\/connected\?stripe=connected/.test(r.headers.location || ''), `lands on /connected?stripe=connected (got ${r.headers.location})`);
  const row = (await sql`SELECT stripe_onboarding_status, stripe_account_label FROM finance_settings WHERE workspace_id = ${wsId}`).rows[0];
  assert(row?.stripe_onboarding_status === 'complete', `status complete (got ${row?.stripe_onboarding_status})`);

  console.log('\n[4] a forged or expired state is refused');
  r = mockRes();
  await callbackHandler(req({ query: { from: 'app', state: state.slice(0, -4) + 'zzzz' } }), r);
  assert(r.statusCode === 401 || (r.statusCode === 302 && /signin/.test(r.headers.location || '')), `bad state falls back to session auth and is refused (got ${r.statusCode} ${r.headers.location || ''})`);

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
run().catch((e) => { console.error('stripe-connect-native test crashed:', e); process.exit(1); });
