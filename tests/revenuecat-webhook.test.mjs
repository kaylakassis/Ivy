// Coverage for the iOS / native-client server paths added for the
// App Store build:
//
//   1. api/billing/revenuecat-webhook.js — the Apple in-app-purchase
//      subscription webhook. Verifies bearer auth, event-id dedup, and
//      the event-type → workspaces.subscription_status mapping that the
//      rest of the app (paywall, dunning) keys off.
//   2. api/_lib/auth.js — readSession now accepts `Authorization:
//      Bearer <jwt>` (native shells can't use the SameSite cookie across
//      the WebView↔API origin gap), and isNativeClient() detects the
//      X-Client-Platform marker.
//
// Run with:
//   node --import ./tests/bootstrap.mjs ./tests/revenuecat-webhook.test.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession, readSession, isNativeClient } from '../api/_lib/auth.js';

const WEBHOOK_SECRET = 'rc_test_secret_at_least_long_enough';
process.env.REVENUECAT_WEBHOOK_SECRET = WEBHOOK_SECRET;

const { default: rcHandler } = await import('../api/billing/revenuecat-webhook.js');

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { pass++; console.log('  ✓', label); }
  else      { fail++; console.log('  ✗', label); }
}

function mkRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(o) { this.body = o; return this; },
    end(s)  { this.body = s; return this; },
  };
}

// RevenueCat posts { event: {...} }. readRawBody returns req.body when
// it's already a string, so we pass the serialized payload directly.
function rcReq(event, { auth = `Bearer ${WEBHOOK_SECRET}` } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (auth) headers.authorization = auth;
  return { method: 'POST', url: '/api/billing/revenuecat-webhook', body: JSON.stringify({ event }), headers };
}

function mkEvent(type, workspaceId, extra = {}) {
  return {
    id: `rc_evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type,
    app_user_id: workspaceId,
    product_id: 'thryve_monthly',
    original_transaction_id: 'apple_txn_123',
    ...extra,
  };
}

async function statusOf(wid) {
  const { rows } = await sql`
    SELECT subscription_status, subscription_source, apple_product_id,
           revenuecat_user_id, converted_at, subscription_past_due_since,
           subscription_period_end
      FROM workspaces WHERE id = ${wid}`;
  return rows[0];
}

async function run() {
  try {
    await ensureSchemaApplied();

    // Fresh owner + workspace for this run.
    const u = await sql`
      INSERT INTO users (email, password_hash, name, terms_version, terms_accepted_at)
      VALUES (${`rc-${Date.now()}@test.local`}, 'x', 'RC Owner', 'v1', NOW())
      RETURNING id`;
    const ownerId = u.rows[0].id;
    const w = await sql`INSERT INTO workspaces (owner_id) VALUES (${ownerId}) RETURNING id`;
    const wid = w.rows[0].id;

    console.log('\n[1] auth: missing / wrong bearer is rejected');
    const noAuth = mkRes();
    await rcHandler(rcReq(mkEvent('INITIAL_PURCHASE', wid), { auth: null }), noAuth);
    assert(noAuth.statusCode === 401, 'no Authorization header → 401');

    const wrongAuth = mkRes();
    await rcHandler(rcReq(mkEvent('INITIAL_PURCHASE', wid), { auth: 'Bearer wrong_secret_value_padding!!' }), wrongAuth);
    assert(wrongAuth.statusCode === 401, 'wrong bearer token → 401');

    console.log('\n[2] INITIAL_PURCHASE flips the workspace to active + apple source');
    const buyEvent = mkEvent('INITIAL_PURCHASE', wid, {
      expiration_at_ms: Date.now() + 30 * 24 * 3600 * 1000,
    });
    const buyRes = mkRes();
    await rcHandler(rcReq(buyEvent), buyRes);
    assert(buyRes.statusCode === 200, 'valid bearer + INITIAL_PURCHASE → 200');
    let s = await statusOf(wid);
    assert(s.subscription_status === 'active', 'subscription_status = active');
    assert(s.subscription_source === 'apple', "subscription_source = 'apple'");
    assert(s.apple_product_id === 'thryve_monthly', 'apple_product_id recorded');
    assert(s.revenuecat_user_id === wid, 'revenuecat_user_id = workspace id');
    assert(s.converted_at != null, 'converted_at stamped on first purchase');

    console.log('\n[3] same event id is deduped on redelivery');
    const dupRes = mkRes();
    await rcHandler(rcReq(buyEvent), dupRes);
    assert(dupRes.statusCode === 200, 'redelivery → 200 (RC stops retrying)');
    assert(dupRes.body?.deduped === true, 'redelivery marked deduped');

    console.log('\n[4] CANCELLATION before period end stays active; EXPIRATION cancels');
    const futureMs = Date.now() + 10 * 24 * 3600 * 1000;
    await rcHandler(rcReq(mkEvent('CANCELLATION', wid, { expiration_at_ms: futureMs })), mkRes());
    s = await statusOf(wid);
    assert(s.subscription_status === 'active', 'CANCELLATION w/ future expiration → still active (paid period)');

    await rcHandler(rcReq(mkEvent('EXPIRATION', wid, { expiration_at_ms: Date.now() - 1000 })), mkRes());
    s = await statusOf(wid);
    assert(s.subscription_status === 'cancelled', 'EXPIRATION → cancelled');

    console.log('\n[5] BILLING_ISSUE → past_due, stamps dunning start');
    await rcHandler(rcReq(mkEvent('BILLING_ISSUE', wid)), mkRes());
    s = await statusOf(wid);
    assert(s.subscription_status === 'past_due', 'BILLING_ISSUE → past_due');
    assert(s.subscription_past_due_since != null, 'subscription_past_due_since stamped');

    console.log('\n[6] RENEWAL recovers to active, clears dunning, keeps original converted_at');
    const convertedBefore = s.converted_at;
    await rcHandler(rcReq(mkEvent('RENEWAL', wid, { expiration_at_ms: Date.now() + 30 * 24 * 3600 * 1000 })), mkRes());
    s = await statusOf(wid);
    assert(s.subscription_status === 'active', 'RENEWAL → active');
    assert(s.subscription_past_due_since == null, 'past_due_since cleared on recovery');
    assert(+new Date(s.converted_at) === +new Date(convertedBefore), 'converted_at unchanged on renewal');

    console.log('\n[7] unknown workspace / event types are accepted as no-ops (no retry storm)');
    const ghostRes = mkRes();
    await rcHandler(rcReq(mkEvent('INITIAL_PURCHASE', '00000000-0000-0000-0000-000000000000')), ghostRes);
    assert(ghostRes.statusCode === 200, 'unknown workspace → 200 no-op');
    const aliasRes = mkRes();
    await rcHandler(rcReq(mkEvent('SUBSCRIBER_ALIAS', wid)), aliasRes);
    assert(aliasRes.statusCode === 200 && aliasRes.body?.ignored === 'SUBSCRIBER_ALIAS', 'ignored event type → 200 ignored');

    console.log('\n[8] readSession / isNativeClient — native Bearer auth path');
    const token = signSession(ownerId);
    const bearerSession = readSession({ headers: { authorization: `Bearer ${token}` } });
    assert(bearerSession?.sub === ownerId, 'readSession reads JWT from Authorization: Bearer');
    const cookieSession = readSession({ headers: { cookie: `ivy_session=${token}` } });
    assert(cookieSession?.sub === ownerId, 'readSession still reads the cookie (web path unchanged)');
    const noSession = readSession({ headers: {} });
    assert(noSession === null, 'no token → null');
    assert(isNativeClient({ headers: { 'x-client-platform': 'ios' } }) === true, "isNativeClient true for 'ios'");
    assert(isNativeClient({ headers: { 'x-client-platform': 'android' } }) === true, "isNativeClient true for 'android'");
    assert(isNativeClient({ headers: {} }) === false, 'isNativeClient false for web (no header)');

    // Cleanup — cascade from workspace + user, and clear dedup rows.
    await sql`DELETE FROM webhook_event_dedup WHERE provider = 'revenuecat'`.catch(() => {});
    await sql`DELETE FROM workspaces WHERE id = ${wid}`.catch(() => {});
    await sql`DELETE FROM users WHERE id = ${ownerId}`.catch(() => {});
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run();
