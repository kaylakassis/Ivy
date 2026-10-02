// Owner↔client messaging moderation (App Review: report + block).
//   • owner blocks client → client send 403 code 'blocked', owner send 403
//   • unblock restores sends
//   • client blocks business → both sends 403; group post 403 while blocked
//   • thread lists carry blocked / blockedByMe
//   • reports create rows with the right role; admin list shows them;
//     PATCH marks reviewed with the resolver + audit row
//   • a client cannot block/report a business they have no client row in
//   • an owner cannot block a client from another workspace
//   • invalid reason / oversized details → 400
//
// Run with: node --import ./tests/bootstrap.mjs ./tests/moderation.test.mjs
process.env.SUPER_ADMIN_EMAIL = `mod-admin-${Date.now()}@example.com`;

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';

const { default: ownerThreads }  = await import('../api/messages/index.js');
const { default: ownerThread }   = await import('../api/messages/[id].js');
const { default: ownerBlocks }   = await import('../api/messages/blocks.js');
const { default: ownerReports }  = await import('../api/messages/reports.js');
const { default: ownerGroups }   = await import('../api/messages/groups/index.js');
const { default: clientThreads } = await import('../api/me/threads/index.js');
const { default: clientThread }  = await import('../api/me/threads/[id].js');
const { default: clientBlocks }  = await import('../api/me/blocks.js');
const { default: clientReports } = await import('../api/me/reports.js');
const { default: clientGroupPost } = await import('../api/me/groups/[id]/messages.js');
const { default: adminReports }  = await import('../api/admin/reports.js');

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

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
function authReq({ method = 'GET', body, query = {}, cookie }) {
  return {
    method, url: '/test', query, body,
    headers: { 'content-type': 'application/json',
      origin: 'http://localhost:3000', host: 'localhost:3000', cookie },
  };
}
async function call(handler, opts) {
  const res = mkRes();
  await handler(authReq(opts), res);
  return res;
}
async function mkUser(email) {
  return (await sql`INSERT INTO users (email, password_hash, email_verified_at, terms_version, terms_accepted_at)
    VALUES (${email}, 'x', NOW(), '2026-05-05', NOW()) RETURNING id`).rows[0].id;
}

async function run() {
  try {
    await ensureSchemaApplied();
    const tag = `mod-${Date.now()}`;

    // Business A: owner + one portal client (Alice).
    const owner = await mkUser(`${tag}-owner@example.com`);
    const ws = (await sql`INSERT INTO workspaces (owner_id, subscription_status, subscription_period_end)
      VALUES (${owner}, 'active', NOW() + INTERVAL '30 days') RETURNING id`).rows[0].id;
    await sql`INSERT INTO calendar_settings (workspace_id, biz_name) VALUES (${ws}, 'Maple Massage') ON CONFLICT DO NOTHING`;
    const uA = await mkUser(`${tag}-alice@example.com`);
    const cA = (await sql`INSERT INTO clients (workspace_id, name, email, stage, user_id)
      VALUES (${ws}, 'Alice', ${`${tag}-alice@example.com`}, 'active', ${uA}) RETURNING id`).rows[0].id;
    // Business B: a different owner + a client Alice is NOT linked to.
    const owner2 = await mkUser(`${tag}-owner2@example.com`);
    const ws2 = (await sql`INSERT INTO workspaces (owner_id, subscription_status, subscription_period_end)
      VALUES (${owner2}, 'active', NOW() + INTERVAL '30 days') RETURNING id`).rows[0].id;
    const cX = (await sql`INSERT INTO clients (workspace_id, name, email, stage)
      VALUES (${ws2}, 'Xavier', ${`${tag}-x@example.com`}, 'active') RETURNING id`).rows[0].id;
    // Operator.
    const admin = (await sql`INSERT INTO users (email, password_hash, email_verified_at, user_type)
      VALUES (${process.env.SUPER_ADMIN_EMAIL}, 'x', NOW(), 'super_admin') RETURNING id`).rows[0].id;

    const ownerCookie = `ivy_session=${signSession(owner)}`;
    const aliceCookie = `ivy_session=${signSession(uA)}`;
    const adminCookie = `ivy_session=${signSession(admin)}`;

    console.log('\n[0] baseline: thread exists and both sides can send');
    let r = await call(ownerThreads, { method: 'POST', cookie: ownerCookie, body: { clientId: cA } });
    assert(r.statusCode === 201, `owner starts thread → 201 (got ${r.statusCode})`);
    const threadId = r.body?.thread?.id;
    r = await call(clientThread, { method: 'POST', cookie: aliceCookie, query: { id: threadId }, body: { text: 'hi' } });
    assert(r.statusCode === 201, `client send → 201 (got ${r.statusCode})`);
    r = await call(ownerThread, { method: 'POST', cookie: ownerCookie, query: { id: threadId }, body: { text: 'hello' } });
    assert(r.statusCode === 201, `owner send → 201 (got ${r.statusCode})`);
    // Open group with Alice in it, for the group-post check later.
    r = await call(ownerGroups, { method: 'POST', cookie: ownerCookie, body: { name: 'Cohort', mode: 'open', clientIds: [cA] } });
    assert(r.statusCode === 201, 'owner creates an open group with Alice');
    const groupId = r.body?.group?.id || r.body?.thread?.id || r.body?.id;
    r = await call(clientGroupPost, { method: 'POST', cookie: aliceCookie, query: { id: groupId }, body: { text: 'hey all' } });
    assert(r.statusCode === 201, `client posts in group → 201 (got ${r.statusCode})`);

    console.log('\n[1] owner blocks client');
    r = await call(ownerBlocks, { method: 'POST', cookie: ownerCookie, body: { clientId: cA, reason: 'rude' } });
    assert(r.statusCode === 200 && r.body?.blocked === true, 'POST /messages/blocks → 200 blocked:true');
    r = await call(ownerBlocks, { method: 'POST', cookie: ownerCookie, body: { clientId: cA } });
    assert(r.statusCode === 200, 'blocking again is idempotent');
    r = await call(ownerBlocks, { method: 'GET', cookie: ownerCookie });
    assert(r.body?.blocks?.length === 1 && r.body.blocks[0].clientId === cA && r.body.blocks[0].clientName === 'Alice' && r.body.blocks[0].reason === 'rude',
      'GET /messages/blocks lists Alice with name + reason');
    r = await call(clientThread, { method: 'POST', cookie: aliceCookie, query: { id: threadId }, body: { text: 'still there?' } });
    assert(r.statusCode === 403 && r.body?.code === 'blocked', `client send while blocked → 403 code=blocked (got ${r.statusCode} ${r.body?.code})`);
    assert(r.body?.error === 'Messaging is turned off between you and this contact.', 'plain-English error copy');
    r = await call(ownerThread, { method: 'POST', cookie: ownerCookie, query: { id: threadId }, body: { text: 'nope' } });
    assert(r.statusCode === 403 && r.body?.code === 'blocked', `owner send while blocked → 403 code=blocked (got ${r.statusCode})`);
    r = await call(clientGroupPost, { method: 'POST', cookie: aliceCookie, query: { id: groupId }, body: { text: 'group post?' } });
    assert(r.statusCode === 403 && r.body?.code === 'blocked', `blocked client cannot post in the business's group → 403 (got ${r.statusCode})`);

    console.log('\n[2] thread lists carry the block flags');
    r = await call(ownerThreads, { method: 'GET', cookie: ownerCookie });
    let t = (r.body?.threads || []).find((x) => x.id === threadId);
    assert(t && t.blocked === true && t.blockedByMe === true, 'owner list: blocked + blockedByMe');
    r = await call(clientThreads, { method: 'GET', cookie: aliceCookie });
    t = (r.body?.threads || []).find((x) => x.id === threadId);
    assert(t && t.blocked === true && t.blockedByMe === false, 'client list: blocked, not blockedByMe');
    r = await call(ownerThread, { method: 'GET', cookie: ownerCookie, query: { id: threadId } });
    assert(r.body?.thread?.blocked === true && r.body.thread.blockedByMe === true, 'owner thread GET carries flags');
    r = await call(clientThread, { method: 'GET', cookie: aliceCookie, query: { id: threadId } });
    assert(r.body?.thread?.blocked === true && r.body.thread.blockedByMe === false, 'client thread GET carries flags');

    console.log('\n[3] unblock restores messaging');
    r = await call(ownerBlocks, { method: 'DELETE', cookie: ownerCookie, body: { clientId: cA } });
    assert(r.statusCode === 204, `DELETE /messages/blocks → 204 (got ${r.statusCode})`);
    r = await call(clientThread, { method: 'POST', cookie: aliceCookie, query: { id: threadId }, body: { text: 'back' } });
    assert(r.statusCode === 201, 'client send after unblock → 201');
    r = await call(ownerThread, { method: 'POST', cookie: ownerCookie, query: { id: threadId }, body: { text: 'welcome back' } });
    assert(r.statusCode === 201, 'owner send after unblock → 201');
    r = await call(ownerThreads, { method: 'GET', cookie: ownerCookie });
    t = (r.body?.threads || []).find((x) => x.id === threadId);
    assert(t && t.blocked === false && t.blockedByMe === false, 'owner list flags cleared');

    console.log('\n[4] client blocks business');
    r = await call(clientBlocks, { method: 'POST', cookie: aliceCookie, body: { workspaceId: ws } });
    assert(r.statusCode === 200 && r.body?.blocked === true, 'POST /me/blocks → 200');
    r = await call(clientBlocks, { method: 'GET', cookie: aliceCookie });
    assert(r.body?.blocks?.length === 1 && r.body.blocks[0].workspaceId === ws && r.body.blocks[0].businessName === 'Maple Massage',
      'GET /me/blocks lists the business by name');
    r = await call(clientThread, { method: 'POST', cookie: aliceCookie, query: { id: threadId }, body: { text: 'x' } });
    assert(r.statusCode === 403 && r.body?.code === 'blocked', 'client send while they blocked → 403');
    r = await call(ownerThread, { method: 'POST', cookie: ownerCookie, query: { id: threadId }, body: { text: 'x' } });
    assert(r.statusCode === 403 && r.body?.code === 'blocked', 'owner send while client blocked → 403');
    r = await call(clientThreads, { method: 'GET', cookie: aliceCookie });
    t = (r.body?.threads || []).find((x) => x.id === threadId);
    assert(t && t.blocked === true && t.blockedByMe === true, 'client list: blocked + blockedByMe');
    r = await call(ownerThreads, { method: 'GET', cookie: ownerCookie });
    t = (r.body?.threads || []).find((x) => x.id === threadId);
    assert(t && t.blocked === true && t.blockedByMe === false, 'owner list: blocked, not blockedByMe');
    r = await call(clientBlocks, { method: 'DELETE', cookie: aliceCookie, body: { workspaceId: ws } });
    assert(r.statusCode === 204, 'DELETE /me/blocks → 204');
    r = await call(clientThread, { method: 'POST', cookie: aliceCookie, query: { id: threadId }, body: { text: 'ok' } });
    assert(r.statusCode === 201, 'client send after unblocking the business → 201');

    console.log('\n[5] scoping: wrong workspace / wrong client');
    r = await call(clientBlocks, { method: 'POST', cookie: aliceCookie, body: { workspaceId: ws2 } });
    assert(r.statusCode === 400, `client cannot block a business they are not a client of (got ${r.statusCode})`);
    r = await call(clientReports, { method: 'POST', cookie: aliceCookie, body: { workspaceId: ws2, targetType: 'business', reason: 'spam' } });
    assert(r.statusCode === 400, `client cannot report a business they are not a client of (got ${r.statusCode})`);
    r = await call(ownerBlocks, { method: 'POST', cookie: ownerCookie, body: { clientId: cX } });
    assert(r.statusCode === 400, `owner cannot block another workspace's client (got ${r.statusCode})`);
    r = await call(ownerReports, { method: 'POST', cookie: ownerCookie, body: { clientId: cX, targetType: 'client', reason: 'spam' } });
    assert(r.statusCode === 400, `owner cannot report another workspace's client (got ${r.statusCode})`);
    const blocksLeft = await sql`SELECT COUNT(*)::int AS n FROM contact_blocks WHERE workspace_id IN (${ws}, ${ws2})`;
    assert(blocksLeft.rows[0].n === 0, 'no stray block rows');

    console.log('\n[6] reports: validation');
    r = await call(ownerReports, { method: 'POST', cookie: ownerCookie, body: { clientId: cA, targetType: 'client', reason: 'because' } });
    assert(r.statusCode === 400, `invalid reason → 400 (got ${r.statusCode})`);
    r = await call(ownerReports, { method: 'POST', cookie: ownerCookie, body: { clientId: cA, targetType: 'client', reason: 'spam', details: 'x'.repeat(2001) } });
    assert(r.statusCode === 400, `details over 2000 chars → 400 (got ${r.statusCode})`);
    r = await call(clientReports, { method: 'POST', cookie: aliceCookie, body: { workspaceId: ws, targetType: 'business', reason: 'nah' } });
    assert(r.statusCode === 400, 'client invalid reason → 400');
    r = await call(ownerReports, { method: 'POST', cookie: ownerCookie, body: { clientId: cA, targetType: 'review', reason: 'spam' } });
    assert(r.statusCode === 400, 'owner cannot use a client-only/unsupported targetType');

    console.log('\n[7] reports: create with the right role');
    r = await call(ownerReports, { method: 'POST', cookie: ownerCookie, body: { clientId: cA, targetType: 'client', reason: 'Harassment', details: 'Kept sending threats.' } });
    assert(r.statusCode === 201 && r.body?.report?.reporterRole === 'owner' && r.body.report.reason === 'harassment',
      `owner report → 201 role=owner (got ${r.statusCode})`);
    const ownerReportId = r.body?.report?.id;
    r = await call(clientReports, { method: 'POST', cookie: aliceCookie, body: { workspaceId: ws, targetType: 'business', reason: 'scam', details: 'Charged twice.' } });
    assert(r.statusCode === 201 && r.body?.report?.reporterRole === 'client' && r.body.report.targetType === 'business',
      `client report → 201 role=client (got ${r.statusCode})`);
    const clientReportId = r.body?.report?.id;
    const rows = (await sql`SELECT * FROM abuse_reports WHERE workspace_id = ${ws} ORDER BY created_at`).rows;
    assert(rows.length === 2 && rows.every((x) => x.status === 'open'), 'two open rows in abuse_reports');
    assert(rows.find((x) => x.id === ownerReportId)?.reporter_user_id === owner, 'owner report records reporter_user_id');
    assert(rows.find((x) => x.id === clientReportId)?.reporter_user_id === uA && rows.find((x) => x.id === clientReportId)?.client_id === cA,
      'client report records reporter + client row');
    r = await call(ownerReports, { method: 'GET', cookie: ownerCookie });
    assert(r.body?.reports?.length === 1 && r.body.reports[0].id === ownerReportId && r.body.reports[0].clientName === 'Alice',
      'owner sees only their own report');
    r = await call(clientReports, { method: 'GET', cookie: aliceCookie });
    assert(r.body?.reports?.length === 1 && r.body.reports[0].id === clientReportId && r.body.reports[0].businessName === 'Maple Massage',
      'client sees only their own report, with the business name');

    console.log('\n[7b] reports stay private from the person reported');
    r = await call(ownerReports, { method: 'GET', cookie: ownerCookie });
    assert(!(r.body?.reports || []).some((x) => x.id === clientReportId), "owner never sees the client's report about the business");
    r = await call(clientReports, { method: 'GET', cookie: aliceCookie });
    assert(!(r.body?.reports || []).some((x) => x.id === ownerReportId), "client never sees the owner's report about them");
    r = await call(ownerThread, { method: 'GET', cookie: ownerCookie, query: { id: threadId } });
    assert(r.statusCode === 200 && !/report/i.test(JSON.stringify(r.body)), 'owner thread view carries no report information');
    r = await call(ownerThreads, { method: 'GET', cookie: ownerCookie });
    assert(!/report/i.test(JSON.stringify(r.body)), 'owner thread list carries no report information');
    r = await call(clientThread, { method: 'GET', cookie: aliceCookie, query: { id: threadId } });
    assert(r.statusCode === 200 && !/report/i.test(JSON.stringify(r.body)), 'client thread view carries no report information');
    r = await call(clientThreads, { method: 'GET', cookie: aliceCookie });
    assert(!/report/i.test(JSON.stringify(r.body)), 'client thread list carries no report information');

    console.log('\n[8] admin queue + resolve');
    r = await call(adminReports, { method: 'GET', cookie: ownerCookie, query: {} });
    assert(r.statusCode === 403, 'non-admin cannot read the queue');
    r = await call(adminReports, { method: 'GET', cookie: adminCookie, query: { status: 'open' } });
    assert(r.statusCode === 200, `admin GET → 200 (got ${r.statusCode})`);
    const mine = (r.body?.reports || []).filter((x) => x.workspaceId === ws);
    assert(mine.length === 2, 'admin list shows both reports');
    const o = mine.find((x) => x.id === ownerReportId);
    const c = mine.find((x) => x.id === clientReportId);
    assert(o && o.reporterRole === 'owner' && o.businessName === 'Maple Massage' && o.clientName === 'Alice' && o.reasonLabel === 'Harassment' && o.details === 'Kept sending threats.',
      'owner report row has business, client, reason label, details');
    assert(c && c.reporterRole === 'client' && c.targetType === 'business' && c.reporterEmail === `${tag}-alice@example.com`,
      'client report row has role, target, reporter email');
    assert((r.body.openCount || 0) >= 2, 'openCount reported');

    r = await call(adminReports, { method: 'PATCH', cookie: adminCookie, body: { id: ownerReportId, status: 'reviewed', resolutionNote: 'Warned the client.' } });
    assert(r.statusCode === 200 && r.body?.report?.status === 'reviewed', `PATCH reviewed → 200 (got ${r.statusCode})`);
    const resolved = (await sql`SELECT * FROM abuse_reports WHERE id = ${ownerReportId}`).rows[0];
    assert(resolved.status === 'reviewed' && resolved.resolved_by_user_id === admin && !!resolved.resolved_at && resolved.resolution_note === 'Warned the client.',
      'row has resolver, timestamp and note');
    const audit = await sql`SELECT * FROM audit_events WHERE action = 'abuse_report.resolve' AND meta->>'reportId' = ${ownerReportId}`;
    assert(audit.rows.length === 1 && audit.rows[0].actor_user_id === admin, 'audit row written');
    r = await call(adminReports, { method: 'PATCH', cookie: adminCookie, body: { id: clientReportId, status: 'bogus' } });
    assert(r.statusCode === 400, 'invalid status → 400');
    r = await call(adminReports, { method: 'GET', cookie: adminCookie, query: { status: 'open' } });
    assert(!(r.body?.reports || []).some((x) => x.id === ownerReportId), 'reviewed report leaves the open filter');
    r = await call(adminReports, { method: 'GET', cookie: adminCookie, query: { status: 'reviewed' } });
    assert((r.body?.reports || []).some((x) => x.id === ownerReportId && x.resolvedByEmail === process.env.SUPER_ADMIN_EMAIL), 'and shows under reviewed with the resolver');

    // Cleanup.
    await sql`DELETE FROM users WHERE id IN (${owner}, ${owner2}, ${uA}, ${admin})`;
  } catch (err) {
    fail++;
    console.error('  ✗ unexpected error:', err);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
run();
