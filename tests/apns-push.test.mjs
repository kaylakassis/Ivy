// APNs push plumbing:
//   1. Provider JWT: valid ES256 structure, verifiable with the public
//      half of a locally-generated P-256 key.
//   2. Payload mapping: our {title, body, url, tag} → aps dictionary.
//   3. /api/push/device: register (upsert), account-switch move,
//      unregister, junk-token rejection, auth required.
//   4. sendPushToUser doesn't explode when neither transport is
//      configured (returns gracefully).
//
// No network: sendApnsToTokens is never invoked against Apple here.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/apns-push.test.mjs
import crypto from 'node:crypto';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import deviceHandler from '../api/push/device.js';
import { sendPushToUser } from '../api/_lib/push.js';

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
let ipN = 0;
function req({ method = 'POST', body = {}, cookie } = {}) {
  ipN++;
  return { method, url: '/test', query: {}, body,
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', host: 'localhost:3000',
      'x-forwarded-for': `198.19.0.${(ipN % 200) + 10}`, ...(cookie ? { cookie } : {}) } };
}

const STAMP = Date.now();
const TOKEN_A = crypto.randomBytes(32).toString('hex');
let userId, userId2, cookie, cookie2;

async function run() {
  await ensureSchemaApplied();
  const u = await sql`INSERT INTO users (email, password_hash, name, email_verified_at)
    VALUES (${`apns-${STAMP}@example.com`}, 'x', 'A', NOW()) RETURNING id`;
  userId = u.rows[0].id;
  cookie = `ivy_session=${signSession(userId)}`;
  const u2 = await sql`INSERT INTO users (email, password_hash, name, email_verified_at)
    VALUES (${`apns2-${STAMP}@example.com`}, 'x', 'B', NOW()) RETURNING id`;
  userId2 = u2.rows[0].id;
  cookie2 = `ivy_session=${signSession(userId2)}`;

  // ── 1. Provider JWT ─────────────────────────────────────────────
  console.log('\n[1] provider JWT signs + verifies as ES256');
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  process.env.APNS_TEAM_ID = 'TEAM123456';
  process.env.APNS_KEY_ID = 'KEY1234567';
  process.env.APNS_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const { buildProviderJwt, buildApnsBody, isApnsConfigured } = await import('../api/_lib/apns.js');
  assert(isApnsConfigured(), 'configured with env set');
  const jwt = buildProviderJwt();
  const [h, c, sig] = jwt.split('.');
  assert(!!h && !!c && !!sig, 'three JWT segments');
  const header = JSON.parse(Buffer.from(h, 'base64url'));
  const claims = JSON.parse(Buffer.from(c, 'base64url'));
  assert(header.alg === 'ES256' && header.kid === 'KEY1234567', `header alg/kid (${JSON.stringify(header)})`);
  assert(claims.iss === 'TEAM123456' && Math.abs(claims.iat - Date.now() / 1000) < 60, 'claims iss/iat');
  const verified = crypto.verify('sha256', Buffer.from(`${h}.${c}`),
    { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'));
  assert(verified, 'signature verifies with the public key');

  // ── 2. Payload mapping ──────────────────────────────────────────
  console.log('\n[2] payload → aps mapping');
  const body = JSON.parse(buildApnsBody({
    title: 'New booking 📅', body: 'Maya · Tomorrow 10:00', url: '/calendar?booking=b1', tag: 'bk-b1',
  }));
  assert(body.aps.alert.title === 'New booking 📅', 'title mapped');
  assert(body.aps.alert.body === 'Maya · Tomorrow 10:00', 'body mapped');
  assert(body.aps['thread-id'] === 'bk-b1', 'tag → thread-id');
  assert(body.url === '/calendar?booking=b1', 'url rides top-level for the tap handler');
  assert(body.aps.sound === 'default', 'sound set');

  // ── 3. Device registry ──────────────────────────────────────────
  console.log('\n[3] /api/push/device lifecycle');
  let r = mockRes();
  await deviceHandler(req({ cookie, body: { token: TOKEN_A, platform: 'ios' } }), r);
  assert(r.statusCode === 200 && r.body?.registered, `register ok (got ${r.statusCode})`);
  r = mockRes();
  await deviceHandler(req({ cookie, body: { token: TOKEN_A } }), r);
  const count = await sql`SELECT COUNT(*)::int AS n FROM push_device_tokens WHERE token = ${TOKEN_A}`;
  assert(count.rows[0].n === 1, 're-register upserts, no duplicate row');

  r = mockRes();
  await deviceHandler(req({ cookie: cookie2, body: { token: TOKEN_A } }), r);
  const owner = await sql`SELECT user_id FROM push_device_tokens WHERE token = ${TOKEN_A}`;
  assert(owner.rows[0].user_id === userId2, 'device switching accounts moves to the new user');

  r = mockRes();
  await deviceHandler(req({ cookie, method: 'DELETE', body: { token: TOKEN_A } }), r);
  const still = await sql`SELECT COUNT(*)::int AS n FROM push_device_tokens WHERE token = ${TOKEN_A}`;
  assert(still.rows[0].n === 1, "another user's DELETE can't remove the row");
  r = mockRes();
  await deviceHandler(req({ cookie: cookie2, method: 'DELETE', body: { token: TOKEN_A } }), r);
  const gone = await sql`SELECT COUNT(*)::int AS n FROM push_device_tokens WHERE token = ${TOKEN_A}`;
  assert(gone.rows[0].n === 0, 'owner DELETE unregisters');

  r = mockRes();
  await deviceHandler(req({ cookie, body: { token: 'not-hex-💥' } }), r);
  assert(r.statusCode === 400, `junk token rejected (got ${r.statusCode})`);
  r = mockRes();
  await deviceHandler(req({ body: { token: TOKEN_A } }), r);
  assert(r.statusCode === 401, `unauthenticated rejected (got ${r.statusCode})`);

  // ── 4. Fanout degrades gracefully with nothing configured ───────
  console.log('\n[4] sendPushToUser with no transports configured');
  delete process.env.APNS_TEAM_ID; // de-configure APNs for this check
  const out = await sendPushToUser({ userId, payload: { title: 'Hello' }, type: 'bookings' });
  assert(out.ok === true, `no-transport send returns ok (${JSON.stringify(out)})`);
}

async function cleanup() {
  await sql`DELETE FROM push_device_tokens WHERE token = ${TOKEN_A}`.catch(() => {});
  if (userId) await sql`DELETE FROM users WHERE id = ${userId}`;
  if (userId2) await sql`DELETE FROM users WHERE id = ${userId2}`;
}

run()
  .catch((e) => { fail++; console.log('  ✗ threw:', e.message, '\n', e.stack); })
  .finally(async () => {
    await cleanup().catch(() => {});
    console.log(`\n────────────────────────────\nPass: ${pass}  Fail: ${fail}`);
    process.exit(fail === 0 ? 0 : 1);
  });
