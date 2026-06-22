// Beta user type: free, full-access, no card, no subscription. End-to-end:
//   • POST /api/admin/users { userType: 'beta' } creates the user with
//     user_type='beta', a workspace marked active, and sends the
//     'You're invited to the Ivy OS beta' invite (subject only - Resend
//     sandbox blocks the actual send in tests).
//   • ensureActiveWorkspace bypasses for user.user_type='beta' (no 402,
//     even if the workspace row's subscription_status is missing).
//   • clientPortal.userContext() synthesizes an always-active sub for them
//     so the Paywall renders nothing on the frontend either.
//   • PATCH role 'beta' on an existing user works, and PATCH 'regular'
//     demotes them back to a fresh trial.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/beta-user.test.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { ensureActiveWorkspace } from '../api/_lib/workspaceGate.js';
import { userContext } from '../api/_lib/clientPortal.js';
import usersHandler from '../api/admin/users.js';
import userByIdHandler from '../api/admin/users/[id].js';

process.env.ADMIN_SECRET ||= 'test-admin-secret';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

function mockRes() {
  return {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; }, end() { return this; }, setHeader() {},
  };
}
let ipN = 0;
function adminReq({ method = 'POST', body = {}, query = {}, url = '/test' } = {}) {
  ipN++;
  return { method, url, query, body,
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', host: 'localhost:3000', 'x-admin-secret': process.env.ADMIN_SECRET, 'x-forwarded-for': `198.51.100.${(ipN % 200) + 10}` } };
}

const createdEmails = [];

async function run() {
  try {
    await ensureSchemaApplied();
    await sql.query(`DELETE FROM users WHERE email LIKE 'beta-test-%@example.com'`);

    console.log('\n[1] POST /api/admin/users creates a Beta user');
    const email = `beta-test-${Date.now()}@example.com`;
    createdEmails.push(email);
    let r = mockRes();
    await usersHandler(adminReq({ body: { email, name: 'Beta Owner', userType: 'beta', sendInvite: false } }), r);
    assert(r.statusCode === 201, 'create returned 201');
    assert(r.body?.user?.classification === 'Beta', 'classification is "Beta"');
    const uRow = (await sql`SELECT id, user_type FROM users WHERE email = ${email}`).rows[0];
    assert(uRow.user_type === 'beta', 'users.user_type is "beta"');
    const wRow = (await sql`SELECT id, subscription_status, subscription_period_end FROM workspaces WHERE owner_id = ${uRow.id}`).rows[0];
    assert(wRow && wRow.subscription_status === 'active', 'workspace is active (belt-and-suspenders)');
    const yearsOut = (new Date(wRow.subscription_period_end).getTime() - Date.now()) / (365.25 * 86400000);
    assert(yearsOut > 50, `period_end is far in the future (~${yearsOut.toFixed(0)} years)`);

    console.log('\n[2] ensureActiveWorkspace returns workspaceId for a Beta user (no paywall)');
    const fakeReq = { method: 'POST', url: '/api/anything', query: {}, headers: { 'x-forwarded-for': '203.0.113.5', origin: 'http://localhost:3000', host: 'localhost:3000' } };
    const gateRes = mockRes();
    const gotId = await ensureActiveWorkspace({ id: uRow.id, user_type: 'beta' }, fakeReq, gateRes);
    assert(gotId === wRow.id, 'gate returned the workspace id (no 402)');
    assert(gateRes.statusCode === 200, 'no error response written');

    console.log('\n[3] userContext synthesizes an always-active subscription for Beta');
    const ctx = await userContext({
      id: uRow.id, email, name: 'Beta Owner', user_type: 'beta', email_verified_at: new Date(),
    });
    assert(ctx.subscription?.isActive === true, 'subscription.isActive = true');
    assert(ctx.subscription?.beta === true, 'subscription flagged beta');
    assert(ctx.subscription?.sponsored === false, 'subscription not flagged sponsored');
    assert(ctx.user.userType === 'beta', 'ctx.user.userType propagates');

    console.log('\n[4] /admin/users list filters by ?type=beta and exposes them as Beta');
    r = mockRes();
    await usersHandler(adminReq({ method: 'GET', query: { type: 'beta', q: email } }), r);
    assert(r.statusCode === 200, 'list returns 200');
    const found = (r.body?.users || []).find((u) => u.email === email);
    assert(!!found, 'beta user is in the filtered list');
    assert(found?.classification === 'Beta', 'classification is Beta');

    console.log('\n[5] PATCH role from beta → regular gives them a fresh 14-day trial');
    r = mockRes();
    await userByIdHandler(adminReq({
      method: 'PATCH', url: `/api/admin/users/${uRow.id}`, body: { role: 'regular' }, query: { id: uRow.id },
    }), r);
    assert(r.statusCode === 200, 'PATCH to regular returns 200');
    const after = (await sql`SELECT user_type FROM users WHERE id = ${uRow.id}`).rows[0];
    assert(after.user_type === 'regular', 'user_type is now regular');
    const ws2 = (await sql`SELECT subscription_status, trial_ends_at FROM workspaces WHERE owner_id = ${uRow.id}`).rows[0];
    assert(ws2.subscription_status === 'trialing', 'workspace is now trialing');
    const days = (new Date(ws2.trial_ends_at).getTime() - Date.now()) / 86400000;
    assert(days > 13 && days <= 14, `fresh 14-day trial (~${days.toFixed(1)})`);

    console.log('\n[6] PATCH role back to beta restores comp + active');
    r = mockRes();
    await userByIdHandler(adminReq({
      method: 'PATCH', url: `/api/admin/users/${uRow.id}`, body: { role: 'beta' }, query: { id: uRow.id },
    }), r);
    assert(r.statusCode === 200, 'PATCH to beta returns 200');
    const after2 = (await sql`SELECT user_type FROM users WHERE id = ${uRow.id}`).rows[0];
    assert(after2.user_type === 'beta', 'user_type is beta again');
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  } finally {
    for (const e of createdEmails) {
      await sql`DELETE FROM workspaces WHERE owner_id = (SELECT id FROM users WHERE email = ${e})`.catch(() => {});
      await sql`DELETE FROM users WHERE email = ${e}`.catch(() => {});
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
run();
