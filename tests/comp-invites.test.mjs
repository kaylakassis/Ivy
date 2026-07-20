// Comp invites: admin grants free access by email → signup with that email
// bypasses the paywall (no Stripe, no card) → revoke restores the paywall.
// Also: inviting an EXISTING account comps it immediately.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/comp-invites.test.mjs
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import { CURRENT_TERMS_VERSION, CURRENT_PRIVACY_VERSION } from '../api/_lib/legal.js';
import { isWorkspaceActive } from '../api/_lib/clientPortal.js';
import { ensureActiveWorkspace, evictWorkspaceGateCache } from '../api/_lib/workspaceGate.js';
import compHandler from '../api/admin/comp-invites.js';
import signupHandler from '../api/auth/signup.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

// Keep the invite email in-process.
const realFetch = globalThis.fetch;
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '{}' });

function mockRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { const key = k.toLowerCase(); if (key === 'set-cookie') { (this.headers[key] ||= []).push(v); } else { this.headers[key] = v; } },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(o) { this.body = o; return this; }, end(s) { this.body = s ?? this.body; return this; },
    writeHead(c) { this.statusCode = c; return this; },
  };
}
let ipN = 0;
function req({ method = 'GET', body = {}, query = {}, cookie } = {}) {
  ipN++;
  return { method, url: '/test', query, body,
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', host: 'localhost:3000',
      'x-forwarded-for': `198.51.100.${(ipN % 200) + 10}`, ...(cookie ? { cookie } : {}) } };
}
const STAMP = Date.now();
const wsRow = async (id) => (await sql`SELECT subscription_status, trial_ends_at, subscription_period_end, comp_until FROM workspaces WHERE id = ${id}`).rows[0];

let adminId, adminCookie, cleanupUserIds = [];
async function run() {
  try {
    await ensureSchemaApplied();
    // Super admin (matches requireSuperAdmin's user_type check).
    const a = await sql`INSERT INTO users (email, password_hash, name, email_verified_at, user_type)
      VALUES (${`comp-admin-${STAMP}@example.com`}, 'x', 'Admin', NOW(), 'super_admin') RETURNING id`;
    adminId = a.rows[0].id;
    cleanupUserIds.push(adminId);
    adminCookie = `ivy_session=${signSession(adminId)}`;

    console.log('\n[1] invite an email that has no account yet');
    let r = mockRes();
    await compHandler(req({ method: 'POST', cookie: adminCookie,
      body: { email: `comp-new-${STAMP}@example.com`, note: 'beta tester' } }), r);
    assert(r.statusCode === 201, `invite created (got ${r.statusCode}: ${JSON.stringify(r.body)})`);
    assert(r.body.compedNow === false, 'not comped yet (no account)');

    console.log('\n[2] signup with the invited email → workspace comped, paywall gone');
    r = mockRes();
    await signupHandler(req({ method: 'POST', body: {
      email: `comp-new-${STAMP}@example.com`, name: 'Comped User',
      password: 'sufficiently-long-pass-123',
      acceptedTermsVersion: CURRENT_TERMS_VERSION, acceptedPrivacyVersion: CURRENT_PRIVACY_VERSION,
    } }), r);
    assert(r.statusCode === 201 || r.statusCode === 200, `signup OK (got ${r.statusCode})`);
    const newUserId = r.body?.user?.id;
    cleanupUserIds.push(newUserId);
    const ws = (await sql`SELECT id FROM workspaces WHERE owner_id = ${newUserId}`).rows[0];
    let row = await wsRow(ws.id);
    assert(!!row.comp_until && new Date(row.comp_until) > new Date(), `comp_until stamped (${row.comp_until})`);
    assert(row.subscription_status === 'incomplete', 'subscription state untouched (no fake Stripe status)');
    assert(isWorkspaceActive(row) === true, 'isWorkspaceActive = true → paywall never shows');
    // Full gate (post-onboarding, so the onboarding bypass is not the reason).
    await sql`UPDATE workspaces SET onboarded_at = NOW() WHERE id = ${ws.id}`;
    evictWorkspaceGateCache(ws.id);
    let gres = mockRes();
    const gate = await ensureActiveWorkspace({ id: newUserId, email: 'x@x.com' }, req({ method: 'PATCH' }), gres);
    assert(gate === ws.id && gres.statusCode === 200, 'gated endpoint passes for comped workspace');

    console.log('\n[3] invite list shows it claimed + active');
    r = mockRes();
    await compHandler(req({ cookie: adminCookie }), r);
    const mine = (r.body.invites || []).find((i) => i.email === `comp-new-${STAMP}@example.com`);
    assert(mine && mine.claimedAt && mine.active, 'listed as claimed + active');

    console.log('\n[4] inviting an EXISTING account comps it immediately (with months)');
    const e2 = `comp-exist-${STAMP}@example.com`;
    const u2 = await sql`INSERT INTO users (email, password_hash, name, email_verified_at)
      VALUES (${e2}, 'x', 'Existing', NOW()) RETURNING id`;
    cleanupUserIds.push(u2.rows[0].id);
    const w2 = await sql`INSERT INTO workspaces (owner_id, subscription_status, trial_ends_at, onboarded_at)
      VALUES (${u2.rows[0].id}, 'incomplete', NULL, NOW()) RETURNING id`;
    r = mockRes();
    await compHandler(req({ method: 'POST', cookie: adminCookie, body: { email: e2, months: 3 } }), r);
    assert(r.statusCode === 201 && r.body.compedNow === true, `existing account comped now (got ${JSON.stringify(r.body)})`);
    let row2 = await wsRow(w2.rows[0].id);
    const months3 = new Date(row2.comp_until).getTime() - Date.now();
    assert(months3 > 80 * 86400e3 && months3 < 100 * 86400e3, '3-month comp window (~90 days)');
    assert(isWorkspaceActive(row2) === true, 'existing workspace unlocked');

    console.log('\n[5] revoke → paywall comes back');
    const invId = mine.id;
    r = mockRes();
    await compHandler(req({ method: 'DELETE', cookie: adminCookie, query: { id: invId } }), r);
    assert(r.statusCode === 204, `revoke 204 (got ${r.statusCode})`);
    row = await wsRow(ws.id);
    assert(row.comp_until === null, 'comp_until cleared');
    assert(isWorkspaceActive(row) === false, 'paywall returns after revoke');
    evictWorkspaceGateCache(ws.id);
    gres = mockRes();
    const gate2 = await ensureActiveWorkspace({ id: newUserId, email: 'x@x.com' }, req({ method: 'PATCH' }), gres);
    assert(gate2 === null && gres.statusCode === 402, 'gated endpoint 402s after revoke');

    console.log('\n[6] non-admin cannot touch comp invites');
    const plain = await sql`INSERT INTO users (email, password_hash, name, email_verified_at)
      VALUES (${`comp-plain-${STAMP}@example.com`}, 'x', 'Plain', NOW()) RETURNING id`;
    cleanupUserIds.push(plain.rows[0].id);
    r = mockRes();
    await compHandler(req({ method: 'POST', cookie: `ivy_session=${signSession(plain.rows[0].id)}`,
      body: { email: 'x@y.com' } }), r);
    assert(r.statusCode === 401 || r.statusCode === 403, `non-admin rejected (got ${r.statusCode})`);
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  } finally {
    globalThis.fetch = realFetch;
    await sql`DELETE FROM comp_invites WHERE email LIKE ${'comp-%-' + STAMP + '@example.com'}`.catch(() => {});
    for (const id of cleanupUserIds.filter(Boolean)) {
      await sql`DELETE FROM workspaces WHERE owner_id = ${id}`.catch(() => {});
      await sql`DELETE FROM users WHERE id = ${id}`.catch(() => {});
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
run();
