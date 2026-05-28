// Client↔client DM tests.
//   • shared-group requirement (cannot DM without one)
//   • basic send + recipient unread bump + read-clears
//   • block (HARD-rejects sender) + mute (still receives, no push)
//   • leave (archive my side only)
//   • report (flags message + creates support_messages with kind='report')
//   • owner has NO endpoint to read these
//
// Run with: node --import ./tests/bootstrap.mjs ./tests/client-dms.test.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_for_local_dev_only_at_least_32_chars';

const { default: dmsList }  = await import('../api/me/dms/index.js');
const { default: dmOne }    = await import('../api/me/dms/[id].js');
const { default: dmSend }   = await import('../api/me/dms/[id]/messages.js');
const { default: dmBlock }  = await import('../api/me/dms/[id]/block.js');
const { default: dmMute }   = await import('../api/me/dms/[id]/mute.js');
const { default: dmReport } = await import('../api/me/dms/[id]/messages/[mid]/report.js');
const { default: ownerGroupsList } = await import('../api/messages/groups/index.js');

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

async function run() {
  try {
    await ensureSchemaApplied();

    const tag = `dm-${Date.now()}`;
    // Owner of the workspace.
    const owner = (await sql`INSERT INTO users (email, password_hash, email_verified_at, terms_version, terms_accepted_at)
      VALUES (${`${tag}-o@example.com`}, 'x', NOW(), '2026-05-05', NOW()) RETURNING id`).rows[0].id;
    const ws = (await sql`INSERT INTO workspaces (owner_id, subscription_status) VALUES (${owner}, 'active') RETURNING id`).rows[0].id;
    // Two portal users → clients of this workspace.
    const uA = (await sql`INSERT INTO users (email, password_hash, email_verified_at, terms_version, terms_accepted_at)
      VALUES (${`${tag}-a@example.com`}, 'x', NOW(), '2026-05-05', NOW()) RETURNING id`).rows[0].id;
    const uB = (await sql`INSERT INTO users (email, password_hash, email_verified_at, terms_version, terms_accepted_at)
      VALUES (${`${tag}-b@example.com`}, 'x', NOW(), '2026-05-05', NOW()) RETURNING id`).rows[0].id;
    const cA = (await sql`INSERT INTO clients (workspace_id, name, email, stage, user_id)
      VALUES (${ws}, 'Alice', ${`${tag}-a@example.com`}, 'active', ${uA}) RETURNING id`).rows[0].id;
    const cB = (await sql`INSERT INTO clients (workspace_id, name, email, stage, user_id)
      VALUES (${ws}, 'Bob', ${`${tag}-b@example.com`}, 'active', ${uB}) RETURNING id`).rows[0].id;
    // A third client in the SAME workspace that DOES NOT share any group with A.
    const uC = (await sql`INSERT INTO users (email, password_hash, email_verified_at, terms_version, terms_accepted_at)
      VALUES (${`${tag}-c@example.com`}, 'x', NOW(), '2026-05-05', NOW()) RETURNING id`).rows[0].id;
    const cC = (await sql`INSERT INTO clients (workspace_id, name, email, stage, user_id)
      VALUES (${ws}, 'Carol', ${`${tag}-c@example.com`}, 'active', ${uC}) RETURNING id`).rows[0].id;
    const cookieA = `thryve_session=${signSession(uA)}`;
    const cookieB = `thryve_session=${signSession(uB)}`;

    console.log('\n[1] cannot DM without a shared group');
    const noShared = mkRes();
    await dmsList(authReq({ method: 'POST', cookie: cookieA, body: { recipientClientId: cC } }), noShared);
    assert(noShared.statusCode === 400, `no shared group → 400 (got ${noShared.statusCode})`);

    // Provision a group containing A and B (NOT C).
    const createR = mkRes();
    const ownerCookie = `thryve_session=${signSession(owner)}`;
    await ownerGroupsList(authReq({
      method: 'POST', cookie: ownerCookie,
      body: { name: 'Cohort', mode: 'open', clientIds: [cA, cB] },
    }), createR);
    assert(createR.statusCode === 201, 'group with A and B created');

    console.log('\n[2] start a DM after shared group exists');
    const startR = mkRes();
    await dmsList(authReq({ method: 'POST', cookie: cookieA, body: { recipientClientId: cB } }), startR);
    assert(startR.statusCode === 201, `start DM → 201 (got ${startR.statusCode})`);
    const dmId = startR.body?.dm?.id;
    assert(!!dmId, 'DM id returned');

    console.log('\n[3] send + recipient unread bumps + read clears');
    const sendR = mkRes();
    await dmSend(authReq({ method: 'POST', cookie: cookieA, query: { id: dmId }, body: { text: 'hi bob' } }), sendR);
    assert(sendR.statusCode === 201, `send → 201 (got ${sendR.statusCode})`);
    // The schema canonicalizes (a,b) so we don't know which UUID is on
    // which side — derive my-side / their-side from the actual row.
    const tRow = (await sql`SELECT client_a_id, unread_a, unread_b FROM client_dm_threads WHERE id = ${dmId}`).rows[0];
    const aIsSender = tRow.client_a_id === cA;
    const senderUnread = aIsSender ? Number(tRow.unread_a) : Number(tRow.unread_b);
    const recipUnread  = aIsSender ? Number(tRow.unread_b) : Number(tRow.unread_a);
    assert(senderUnread === 0 && recipUnread === 1,
      `sender's side stays 0, recipient bumps to 1 (sender=${senderUnread}, recip=${recipUnread})`);
    // B fetches → clears B's unread.
    const fetchB = mkRes();
    await dmOne(authReq({ method: 'GET', cookie: cookieB, query: { id: dmId } }), fetchB);
    assert(fetchB.statusCode === 200, 'B reads thread');
    const after = (await sql`SELECT client_a_id, unread_a, unread_b FROM client_dm_threads WHERE id = ${dmId}`).rows[0];
    const bUnread = after.client_a_id === cB ? Number(after.unread_a) : Number(after.unread_b);
    assert(bUnread === 0, 'B unread cleared');

    console.log('\n[4] block: B blocks A → A cannot send');
    const blockR = mkRes();
    await dmBlock(authReq({ method: 'POST', cookie: cookieB, query: { id: dmId } }), blockR);
    assert(blockR.statusCode === 200, `B blocks A → 200`);
    const blockedSend = mkRes();
    await dmSend(authReq({ method: 'POST', cookie: cookieA, query: { id: dmId }, body: { text: 'still there?' } }), blockedSend);
    assert(blockedSend.statusCode === 403, `blocked send → 403 (got ${blockedSend.statusCode})`);
    // B's fetch should NOT include A's earlier messages (filtered out).
    const bView = mkRes();
    await dmOne(authReq({ method: 'GET', cookie: cookieB, query: { id: dmId } }), bView);
    assert(bView.body?.messages?.length === 0, "B no longer sees A's history while blocked");
    // Unblock — A can send again.
    await dmBlock(authReq({ method: 'DELETE', cookie: cookieB, query: { id: dmId } }), mkRes());
    const ok2 = mkRes();
    await dmSend(authReq({ method: 'POST', cookie: cookieA, query: { id: dmId }, body: { text: 'ok thanks' } }), ok2);
    assert(ok2.statusCode === 201, 'unblock restores send');

    console.log('\n[5] mute: B mutes A → record exists, message still lands');
    await dmMute(authReq({ method: 'POST', cookie: cookieB, query: { id: dmId } }), mkRes());
    const muteRow = await sql`SELECT 1 FROM client_dm_mutes WHERE muter_client_id = ${cB} AND muted_client_id = ${cA}`;
    assert(muteRow.rows.length === 1, 'mute row persisted');
    const muteSend = mkRes();
    await dmSend(authReq({ method: 'POST', cookie: cookieA, query: { id: dmId }, body: { text: 'while muted' } }), muteSend);
    assert(muteSend.statusCode === 201, 'mute does not block sends');

    console.log('\n[6] leave (archive my side); reappears on next message');
    await dmOne(authReq({ method: 'DELETE', cookie: cookieB, query: { id: dmId } }), mkRes());
    const listAfterLeave = mkRes();
    await dmsList(authReq({ method: 'GET', cookie: cookieB }), listAfterLeave);
    assert(listAfterLeave.body?.dms?.length === 0, "B's list is empty after leave");
    // A sends again → un-archives B's side automatically.
    await dmSend(authReq({ method: 'POST', cookie: cookieA, query: { id: dmId }, body: { text: 'still here' } }), mkRes());
    const listResurface = mkRes();
    await dmsList(authReq({ method: 'GET', cookie: cookieB }), listResurface);
    assert(listResurface.body?.dms?.length === 1, "B's thread resurfaces on new message");

    console.log('\n[7] report a message → support_messages with kind=report');
    // Last A→B message id.
    const lastMsg = (await sql`SELECT id FROM client_dm_messages WHERE thread_id = ${dmId} AND sender_client_id = ${cA} ORDER BY created_at DESC LIMIT 1`).rows[0];
    const reportR = mkRes();
    await dmReport(authReq({
      method: 'POST', cookie: cookieB,
      query: { id: dmId, mid: lastMsg.id }, body: { reason: 'spam' },
    }), reportR);
    assert(reportR.statusCode === 200, `report → 200 (got ${reportR.statusCode})`);
    const flagged = (await sql`SELECT reported_at, reported_by_client_id FROM client_dm_messages WHERE id = ${lastMsg.id}`).rows[0];
    assert(!!flagged.reported_at && flagged.reported_by_client_id === cB, 'message flagged + reporter recorded');
    const supportThread = (await sql`SELECT id FROM support_threads WHERE user_id = ${uB}`).rows[0];
    assert(!!supportThread, 'reporter support thread exists');
    const supportRow = (await sql`SELECT * FROM support_messages WHERE thread_id = ${supportThread.id} AND kind = 'report' ORDER BY created_at DESC LIMIT 1`).rows[0];
    assert(!!supportRow && supportRow.text.includes('[REPORT]'), 'support message with kind=report posted');
    assert(supportRow.meta?.reportedMessageId === lastMsg.id, 'report meta carries the reported message id');

    console.log('\n[8] cannot report your own message');
    const selfReportTarget = (await sql`SELECT id FROM client_dm_messages WHERE thread_id = ${dmId} AND sender_client_id = ${cA} LIMIT 1`).rows[0];
    const selfReport = mkRes();
    await dmReport(authReq({
      method: 'POST', cookie: cookieA,  // A trying to report A's own message
      query: { id: dmId, mid: selfReportTarget.id }, body: {},
    }), selfReport);
    assert(selfReport.statusCode === 400, 'self-report → 400');

    // Cleanup
    await sql`DELETE FROM support_messages WHERE thread_id IN (SELECT id FROM support_threads WHERE user_id IN (${uA}, ${uB}, ${uC}))`;
    await sql`DELETE FROM support_threads WHERE user_id IN (${uA}, ${uB}, ${uC})`;
    await sql`DELETE FROM client_dm_blocks WHERE workspace_id = ${ws}`;
    await sql`DELETE FROM client_dm_mutes WHERE workspace_id = ${ws}`;
    await sql`DELETE FROM client_dm_messages WHERE workspace_id = ${ws}`;
    await sql`DELETE FROM client_dm_threads WHERE workspace_id = ${ws}`;
    await sql`DELETE FROM group_messages WHERE workspace_id = ${ws}`;
    await sql`DELETE FROM group_thread_members WHERE workspace_id = ${ws}`;
    await sql`DELETE FROM group_threads WHERE workspace_id = ${ws}`;
    await sql`DELETE FROM clients WHERE workspace_id = ${ws}`;
    await sql`DELETE FROM workspaces WHERE id = ${ws}`;
    await sql`DELETE FROM users WHERE id IN (${owner}, ${uA}, ${uB}, ${uC})`;
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run();
