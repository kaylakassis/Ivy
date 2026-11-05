// Push registrations cannot be hijacked.
//   /api/push/device: a LIVE APNs token stays with its owner; another
//   account can only take it over once it is stale (30 days unused) or
//   after the owner unregisters it.
//   /api/push/subscribe: the web-push endpoint must be https on a known
//   push service, never an arbitrary or internal host.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/push-token-binding.test.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import deviceHandler from '../api/push/device.js';
import subscribeHandler, { allowedPushEndpoint } from '../api/push/subscribe.js';
import unsubscribeHandler from '../api/push/unsubscribe.js';

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
const req = ({ method = 'POST', body = {}, cookie } = {}) => ({
  method, body, query: {},
  headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', host: 'localhost:3000', ...(cookie ? { cookie } : {}) },
});

const TAG = `ptb${Date.now().toString(16)}`;
const TOKEN = (TAG + 'a'.repeat(64)).slice(0, 64).replace(/[^0-9a-f]/g, 'b');
const users = [];
async function mkUser(label) {
  const u = await sql`INSERT INTO users (email, password_hash, name, terms_version, terms_accepted_at)
    VALUES (${`${TAG}-${label}@test.local`}, 'x', ${label}, 'v1', NOW()) RETURNING id`;
  users.push(u.rows[0].id);
  return { id: u.rows[0].id, cookie: `ivy_session=${signSession(u.rows[0].id)}` };
}
const ownerOf = async () => (await sql`SELECT user_id FROM push_device_tokens WHERE token = ${TOKEN}`).rows[0]?.user_id || null;

try {
  await ensureSchemaApplied();
  const a = await mkUser('a');
  const b = await mkUser('b');

  console.log('\n[1] a live device token cannot be re-bound by another account');
  let r = mkRes();
  await deviceHandler(req({ cookie: a.cookie, body: { token: TOKEN, platform: 'ios' } }), r);
  assert(r.statusCode === 200 && r.body?.registered === true, 'A registers the token');
  r = mkRes();
  await deviceHandler(req({ cookie: b.cookie, body: { token: TOKEN, platform: 'ios' } }), r);
  assert(r.statusCode === 200 && r.body?.registered === false && r.body?.reason === 'token-in-use', `B's register is refused softly (${JSON.stringify(r.body)})`);
  assert((await ownerOf()) === a.id, 'token still belongs to A');
  r = mkRes();
  await deviceHandler(req({ cookie: a.cookie, body: { token: TOKEN, platform: 'ios' } }), r);
  assert(r.body?.registered === true, 'A re-registering still works (refresh)');

  console.log('\n[2] a stale token (unused 30+ days) can be reclaimed by a new owner');
  await sql`UPDATE push_device_tokens SET last_used_at = NOW() - INTERVAL '31 days' WHERE token = ${TOKEN}`;
  r = mkRes();
  await deviceHandler(req({ cookie: b.cookie, body: { token: TOKEN, platform: 'ios' } }), r);
  assert(r.body?.registered === true && (await ownerOf()) === b.id, 'stale token moves to B');

  console.log('\n[3] after the owner unregisters, the next account can register it');
  r = mkRes();
  await deviceHandler(req({ cookie: b.cookie, method: 'DELETE', body: { token: TOKEN } }), r);
  r = mkRes();
  await deviceHandler(req({ cookie: a.cookie, body: { token: TOKEN, platform: 'ios' } }), r);
  assert(r.body?.registered === true && (await ownerOf()) === a.id, 'sign-out then sign-in on one device still hands the token over');

  console.log('\n[4] web-push endpoint allowlist');
  const okEndpoints = [
    'https://fcm.googleapis.com/fcm/send/abc:APA91b',
    'https://updates.push.services.mozilla.com/wpush/v2/gAAAA',
    'https://web.push.apple.com/QHbd0fZ',
    'https://wns2-par02p.notify.windows.com/w/?token=AwYAAA',
    'https://eu.push.samsungosp.com/v1/push/abc',
  ];
  for (const e of okEndpoints) assert(allowedPushEndpoint(e) === e, `allowed: ${new URL(e).host}`);
  const badEndpoints = [
    'http://fcm.googleapis.com/fcm/send/abc',
    'https://169.254.169.254/latest/meta-data/',
    'https://[::1]/x',
    'https://127.0.0.1/x',
    'https://evil.example.com/collect',
    'https://fcm.googleapis.com.evil.example/x',
    'https://user:pw@fcm.googleapis.com/x',
    'https://notify.windows.com.attacker.net/x',
    'not a url',
  ];
  for (const e of badEndpoints) assert(allowedPushEndpoint(e) === null, `rejected: ${e}`);

  console.log('\n[5] /api/push/subscribe refuses an unknown endpoint host and accepts a known one');
  r = mkRes();
  await subscribeHandler(req({ cookie: a.cookie, body: { endpoint: 'https://10.0.0.5/hook', keys: { p256dh: 'p', auth: 'a' } } }), r);
  assert(r.statusCode === 400, `private endpoint → 400 (${r.statusCode})`);
  r = mkRes();
  await subscribeHandler(req({ cookie: a.cookie, body: { endpoint: 'https://attacker.example/collect', keys: { p256dh: 'p', auth: 'a' } } }), r);
  assert(r.statusCode === 400, `unknown host → 400 (${r.statusCode})`);
  const goodEndpoint = `https://fcm.googleapis.com/fcm/send/${TAG}`;
  r = mkRes();
  await subscribeHandler(req({ cookie: a.cookie, body: { endpoint: goodEndpoint, keys: { p256dh: 'p', auth: 'a' } } }), r);
  assert(r.statusCode === 200, `known push service → 200 (${r.statusCode})`);
  const saved = await sql`SELECT COUNT(*)::int AS c FROM push_subscriptions WHERE endpoint = ${goodEndpoint} AND user_id = ${a.id}`;
  assert(saved.rows[0].c === 1, 'subscription stored');

  console.log('\n[6] one browser, one account: the next sign-in takes the subscription over');
  r = mkRes();
  await subscribeHandler(req({ cookie: b.cookie, body: { endpoint: goodEndpoint, keys: { p256dh: 'p2', auth: 'a2' } } }), r);
  assert(r.statusCode === 200, 'B subscribes from the same browser');
  const holders = (await sql`SELECT user_id FROM push_subscriptions WHERE endpoint = ${goodEndpoint}`).rows.map((x) => x.user_id);
  assert(holders.length === 1 && holders[0] === b.id, `only B is bound now, A no longer gets pushed to B's browser (${holders.length})`);

  console.log('\n[7] sign-out release: unsubscribe and device DELETE only touch your own rows');
  r = mkRes();
  await unsubscribeHandler(req({ cookie: a.cookie, body: { endpoint: goodEndpoint } }), r);
  assert((await sql`SELECT COUNT(*)::int AS c FROM push_subscriptions WHERE endpoint = ${goodEndpoint}`).rows[0].c === 1, "A cannot remove B's browser subscription");
  r = mkRes();
  await unsubscribeHandler(req({ cookie: b.cookie, body: { endpoint: goodEndpoint } }), r);
  assert((await sql`SELECT COUNT(*)::int AS c FROM push_subscriptions WHERE endpoint = ${goodEndpoint}`).rows[0].c === 0, 'B signing out releases it');
  r = mkRes();
  await deviceHandler(req({ cookie: a.cookie, body: { token: TOKEN, platform: 'ios' } }), r);
  r = mkRes();
  await deviceHandler(req({ cookie: b.cookie, method: 'DELETE', body: { token: TOKEN } }), r);
  assert((await ownerOf()) === a.id, "B's sign-out cannot drop A's iPhone token");
  r = mkRes();
  await deviceHandler(req({ cookie: a.cookie, method: 'DELETE', body: { token: TOKEN } }), r);
  r = mkRes();
  await deviceHandler(req({ cookie: b.cookie, body: { token: TOKEN, platform: 'ios' } }), r);
  assert(r.body?.registered === true && (await ownerOf()) === b.id, 'after A signs out on the phone, B signing in gets the phone straight away');
} catch (err) {
  console.error('Fatal:', err.message, err.stack);
  fail++;
} finally {
  await sql`DELETE FROM push_device_tokens WHERE token = ${TOKEN}`.catch(() => {});
  await sql`DELETE FROM push_subscriptions WHERE endpoint LIKE ${`%${TAG}%`}`.catch(() => {});
  for (const uid of users) await sql`DELETE FROM users WHERE id = ${uid}`.catch(() => {});
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
