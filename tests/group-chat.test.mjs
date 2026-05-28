// End-to-end tests for cohort group chat (owner + many clients).
// Fires real HTTP-shape requests at the handlers (mock req/res),
// exercises owner CRUD, multi-tenant isolation, mode enforcement,
// unread fan-out, and the client-portal flow.
//
// Run with:
//   node --import ./tests/bootstrap.mjs ./tests/group-chat.test.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_for_local_dev_only_at_least_32_chars';

const { default: groupsList }    = await import('../api/messages/groups/index.js');
const { default: groupOne }      = await import('../api/messages/groups/[id].js');
const { default: groupMembers }  = await import('../api/messages/groups/[id]/members.js');
const { default: groupMsgs }     = await import('../api/messages/groups/[id]/messages.js');
const { default: meGroupsList }  = await import('../api/me/groups/index.js');
const { default: meGroupOne }    = await import('../api/me/groups/[id].js');
const { default: meGroupSend }   = await import('../api/me/groups/[id]/messages.js');
const { default: meGroupLeave }  = await import('../api/me/groups/[id]/leave.js');
const { default: ownerReact }    = await import('../api/messages/groups/[id]/messages/[mid]/reactions.js');
const { default: clientReact }   = await import('../api/me/groups/[id]/messages/[mid]/reactions.js');
const { default: invites }       = await import('../api/messages/groups/[id]/invites.js');
const { default: acceptInvite }  = await import('../api/me/groups/accept-invite.js');

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
function ownerReq({ method = 'GET', body, query = {}, cookie }) {
  return {
    method, url: '/test', query, body,
    headers: {
      'content-type': 'application/json',
      origin: 'http://localhost:3000', host: 'localhost:3000',
      cookie,
    },
  };
}

async function run() {
  try {
    await ensureSchemaApplied();

    const tag = `gc-${Date.now()}`;
    // Two owners/workspaces — cross-tenant isolation fixture.
    const owner1 = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, terms_version, terms_accepted_at)
      VALUES (${`${tag}-o1@example.com`}, 'x', 'Owner1', NOW(), '2026-05-05', NOW()) RETURNING id`).rows[0].id;
    const ws1 = (await sql`INSERT INTO workspaces (owner_id, subscription_status) VALUES (${owner1}, 'active') RETURNING id`).rows[0].id;
    const owner2 = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, terms_version, terms_accepted_at)
      VALUES (${`${tag}-o2@example.com`}, 'x', 'Owner2', NOW(), '2026-05-05', NOW()) RETURNING id`).rows[0].id;
    const ws2 = (await sql`INSERT INTO workspaces (owner_id, subscription_status) VALUES (${owner2}, 'active') RETURNING id`).rows[0].id;

    // Three clients in ws1 — first one will also be a portal user.
    const portalUser = (await sql`INSERT INTO users (email, password_hash, email_verified_at, terms_version, terms_accepted_at)
      VALUES (${`${tag}-pu@example.com`}, 'x', NOW(), '2026-05-05', NOW()) RETURNING id`).rows[0].id;
    const c1 = (await sql`INSERT INTO clients (workspace_id, name, email, stage, user_id)
      VALUES (${ws1}, 'Alice', ${`${tag}-pu@example.com`}, 'active', ${portalUser}) RETURNING id`).rows[0].id;
    const c2 = (await sql`INSERT INTO clients (workspace_id, name, email, stage)
      VALUES (${ws1}, 'Bob', ${`${tag}-b@example.com`}, 'active') RETURNING id`).rows[0].id;
    const c3 = (await sql`INSERT INTO clients (workspace_id, name, email, stage)
      VALUES (${ws1}, 'Carol', ${`${tag}-c@example.com`}, 'active') RETURNING id`).rows[0].id;
    // Client in ws2 — cross-tenant target.
    const cOther = (await sql`INSERT INTO clients (workspace_id, name, email, stage)
      VALUES (${ws2}, 'Eve', ${`${tag}-eve@example.com`}, 'active') RETURNING id`).rows[0].id;

    const cookie1 = `thryve_session=${signSession(owner1)}`;
    const cookie2 = `thryve_session=${signSession(owner2)}`;
    const cookieClient = `thryve_session=${signSession(portalUser)}`;

    // ─── 1. Create ───────────────────────────────────────────────
    console.log('\n[1] owner creates a cohort group');
    const r1 = mkRes();
    await groupsList(ownerReq({
      method: 'POST', cookie: cookie1,
      body: {
        name: 'Tuesday 7am Yoga', description: 'Cohort chat',
        mode: 'open', clientIds: [c1, c2, c3, cOther], // cOther will be dropped
      },
    }), r1);
    assert(r1.statusCode === 201, `create → 201 (got ${r1.statusCode})`);
    const gid = r1.body?.group?.id;
    assert(!!gid, 'group id returned');
    assert(r1.body?.group?.memberCount === 3, `cross-tenant client dropped (memberCount=${r1.body?.group?.memberCount})`);

    // ─── 2. Owner lists groups ───────────────────────────────────
    console.log('\n[2] owner sees the new group');
    const r2 = mkRes();
    await groupsList(ownerReq({ method: 'GET', cookie: cookie1 }), r2);
    assert(r2.statusCode === 200 && r2.body?.groups?.length === 1, 'list returns 1 group');

    console.log('\n[3] owner2 does NOT see ws1\'s group');
    const r3 = mkRes();
    await groupsList(ownerReq({ method: 'GET', cookie: cookie2 }), r3);
    assert(r3.body?.groups?.length === 0, 'cross-tenant list is empty');

    // ─── 4. Cross-tenant fetch is 404 ────────────────────────────
    console.log('\n[4] owner2 cannot fetch ws1 group');
    const r4 = mkRes();
    await groupOne(ownerReq({ method: 'GET', cookie: cookie2, query: { id: gid } }), r4);
    assert(r4.statusCode === 404, `cross-tenant GET → 404 (got ${r4.statusCode})`);

    // ─── 5. Owner sends a message; fan-out increments member unread ───
    console.log('\n[5] owner sends; every member\'s unread_count → 1');
    const r5 = mkRes();
    await groupMsgs(ownerReq({
      method: 'POST', cookie: cookie1, query: { id: gid },
      body: { text: 'Welcome to the cohort 👋' },
    }), r5);
    assert(r5.statusCode === 201, `send → 201 (got ${r5.statusCode}, body=${JSON.stringify(r5.body)})`);
    const counts = await sql`SELECT client_id, unread_count FROM group_thread_members WHERE thread_id = ${gid}`;
    const map = Object.fromEntries(counts.rows.map((r) => [r.client_id, r.unread_count]));
    assert(map[c1] === 1 && map[c2] === 1 && map[c3] === 1, `all 3 members at unread=1 (got ${JSON.stringify(map)})`);

    // ─── 6. Client portal: list + fetch + send ───────────────────
    console.log('\n[6] client sees the group in /me/groups');
    const r6 = mkRes();
    await meGroupsList(ownerReq({ method: 'GET', cookie: cookieClient }), r6);
    assert(r6.statusCode === 200 && r6.body?.groups?.length === 1, 'portal lists 1 group');
    assert(r6.body?.groups?.[0]?.unreadClient === 1, `unreadClient=1 (got ${r6.body?.groups?.[0]?.unreadClient})`);

    console.log('\n[7] client GET clears their unread + returns messages');
    const r7 = mkRes();
    await meGroupOne(ownerReq({ method: 'GET', cookie: cookieClient, query: { id: gid } }), r7);
    assert(r7.statusCode === 200, `GET → 200 (got ${r7.statusCode})`);
    assert(r7.body?.messages?.length >= 1, `messages returned (${r7.body?.messages?.length})`);
    assert(r7.body?.canReply === true, 'canReply=true for open mode');
    const afterRead = await sql`SELECT unread_count FROM group_thread_members WHERE thread_id = ${gid} AND client_id = ${c1}`;
    assert(afterRead.rows[0].unread_count === 0, 'this client\'s unread cleared');

    console.log('\n[8] client replies; owner sees unread_biz=1, other members unread+=1');
    const r8 = mkRes();
    await meGroupSend(ownerReq({
      method: 'POST', cookie: cookieClient, query: { id: gid },
      body: { text: 'Thanks for adding me!' },
    }), r8);
    assert(r8.statusCode === 201, `client send → 201 (got ${r8.statusCode}, body=${JSON.stringify(r8.body)})`);
    const t = (await sql`SELECT unread_biz FROM group_threads WHERE id = ${gid}`).rows[0];
    assert(t.unread_biz === 1, `owner unread_biz=1 (got ${t.unread_biz})`);
    const after = await sql`SELECT client_id, unread_count FROM group_thread_members WHERE thread_id = ${gid}`;
    const map2 = Object.fromEntries(after.rows.map((r) => [r.client_id, r.unread_count]));
    assert(map2[c1] === 0 && map2[c2] === 2 && map2[c3] === 2, `Alice unread=0, others incremented (got ${JSON.stringify(map2)})`);

    // ─── 9. Broadcast mode rejects client send ───────────────────
    console.log('\n[9] PATCH to broadcast mode; client send is forbidden');
    const r9 = mkRes();
    await groupOne(ownerReq({ method: 'PATCH', cookie: cookie1, query: { id: gid }, body: { mode: 'broadcast' } }), r9);
    assert(r9.statusCode === 200 && r9.body?.group?.mode === 'broadcast', `mode flipped (got '${r9.body?.group?.mode}')`);

    const r10 = mkRes();
    await meGroupSend(ownerReq({
      method: 'POST', cookie: cookieClient, query: { id: gid },
      body: { text: 'Can I reply?' },
    }), r10);
    assert(r10.statusCode === 403, `client send in broadcast → 403 (got ${r10.statusCode})`);

    // ─── 10. Cross-tenant add reject ─────────────────────────────
    console.log('\n[10] add cross-tenant clientId silently dropped');
    const r11 = mkRes();
    await groupMembers(ownerReq({
      method: 'POST', cookie: cookie1, query: { id: gid },
      body: { clientIds: [cOther] },
    }), r11);
    assert(r11.statusCode === 400, `no valid clients → 400 (got ${r11.statusCode})`);

    // ─── 11. Client leaves ───────────────────────────────────────
    console.log('\n[11] client leaves the group');
    const r12 = mkRes();
    await meGroupLeave(ownerReq({ method: 'POST', cookie: cookieClient, query: { id: gid } }), r12);
    assert(r12.statusCode === 200, `leave → 200 (got ${r12.statusCode})`);
    const afterLeave = mkRes();
    await meGroupOne(ownerReq({ method: 'GET', cookie: cookieClient, query: { id: gid } }), afterLeave);
    assert(afterLeave.statusCode === 404, 'group no longer visible after leave');

    // ─── 12. Owner archive ───────────────────────────────────────
    console.log('\n[12] owner archives the group');
    const r13 = mkRes();
    await groupOne(ownerReq({ method: 'DELETE', cookie: cookie1, query: { id: gid } }), r13);
    assert(r13.statusCode === 204, `archive → 204 (got ${r13.statusCode})`);
    const list = mkRes();
    await groupsList(ownerReq({ method: 'GET', cookie: cookie1 }), list);
    assert(list.body?.groups?.length === 0, 'archived group hidden from default list');
    const listAll = mkRes();
    await groupsList(ownerReq({ method: 'GET', cookie: cookie1, query: { includeArchived: '1' } }), listAll);
    assert(listAll.body?.groups?.length === 1, 'includeArchived=1 brings it back');

    // ─── 13. Threading + reactions + mentions + invites ──────────
    // Fresh group for these — the previous one is archived.
    console.log('\n[13] threading + reactions + mentions + invite-by-link');
    const createR = mkRes();
    await groupsList(ownerReq({
      method: 'POST', cookie: cookie1,
      body: { name: 'Phase2 Group', mode: 'open', clientIds: [c1, c2, c3] },
    }), createR);
    const gid2 = createR.body?.group?.id;
    assert(!!gid2, 'phase-2 group created');

    // Owner sends a top-level message that mentions Bob (c2).
    const sendMention = mkRes();
    await groupMsgs(ownerReq({
      method: 'POST', cookie: cookie1, query: { id: gid2 },
      body: { text: 'Hey @Bob can you bring the mats?' },
    }), sendMention);
    assert(sendMention.statusCode === 201, '@mention send → 201');
    assert(sendMention.body?.message?.mentions?.length === 1
      && sendMention.body.message.mentions[0].clientId === c2,
      'mention resolved to Bob');
    const parentId = sendMention.body.message.id;
    const mentionRow = await sql`SELECT * FROM group_message_mentions WHERE message_id = ${parentId}`;
    assert(mentionRow.rows.length === 1 && mentionRow.rows[0].mentioned_client_id === c2,
      'mention persisted');

    // Alice replies in the thread.
    const reply = mkRes();
    await meGroupSend(ownerReq({
      method: 'POST', cookie: cookieClient, query: { id: gid2 },
      body: { text: 'On it!', parentMessageId: parentId },
    }), reply);
    assert(reply.statusCode === 201, 'threaded reply → 201');
    assert(reply.body?.message?.parentMessageId === parentId, 'parentMessageId stored');

    // Bad parentMessageId is rejected.
    const badReply = mkRes();
    await meGroupSend(ownerReq({
      method: 'POST', cookie: cookieClient, query: { id: gid2 },
      body: { text: 'x', parentMessageId: 'a0000000-0000-0000-0000-000000000000' },
    }), badReply);
    assert(badReply.statusCode === 400, `unknown parent → 400 (got ${badReply.statusCode})`);

    // Owner reacts with 👍 to Alice's reply.
    const replyId = reply.body.message.id;
    const reactOwner = mkRes();
    await ownerReact(ownerReq({
      method: 'POST', cookie: cookie1, query: { id: gid2, mid: replyId },
      body: { emoji: '👍' },
    }), reactOwner);
    assert(reactOwner.statusCode === 200, 'owner reacted');

    // Alice also reacts with 👍.
    const reactClient = mkRes();
    await clientReact(ownerReq({
      method: 'POST', cookie: cookieClient, query: { id: gid2, mid: replyId },
      body: { emoji: '👍' },
    }), reactClient);
    assert(reactClient.statusCode === 200, 'client reacted');

    // Fetch via owner — should see count=2 with mine=true.
    const fetchOwner = mkRes();
    await groupOne(ownerReq({ method: 'GET', cookie: cookie1, query: { id: gid2 } }), fetchOwner);
    const replyMsg = fetchOwner.body.messages.find((m) => m.id === replyId);
    const thumbs = replyMsg?.reactions?.find((r) => r.emoji === '👍');
    assert(thumbs && thumbs.count === 2 && thumbs.mine === true,
      `owner sees count=2, mine=true (got ${JSON.stringify(thumbs)})`);

    // Owner removes reaction.
    const unreact = mkRes();
    await ownerReact(ownerReq({
      method: 'DELETE', cookie: cookie1, query: { id: gid2, mid: replyId, emoji: '👍' },
    }), unreact);
    assert(unreact.statusCode === 204, 'owner unreacted → 204');

    // Invite-by-link: owner mints, second portal user accepts.
    const invR = mkRes();
    await invites(ownerReq({
      method: 'POST', cookie: cookie1, query: { id: gid2 },
      body: { maxUses: 5, expiresInHours: 24 },
    }), invR);
    assert(invR.statusCode === 200 && !!invR.body?.invite?.token, 'invite token minted');
    const plaintext = invR.body.invite.token;

    // New user signs up + accepts.
    const newUser = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, terms_version, terms_accepted_at)
      VALUES (${`${tag}-nu@example.com`}, 'x', 'New', NOW(), '2026-05-05', NOW()) RETURNING id`).rows[0].id;
    const newCookie = `thryve_session=${signSession(newUser)}`;
    const acc = mkRes();
    await acceptInvite(ownerReq({
      method: 'POST', cookie: newCookie, body: { token: plaintext },
    }), acc);
    assert(acc.statusCode === 200 && acc.body?.groupId === gid2, `invite accepted (got ${JSON.stringify(acc.body)})`);
    const memberNow = await sql`
      SELECT COUNT(*)::int AS n FROM group_thread_members m
        JOIN clients c ON c.id = m.client_id
       WHERE m.thread_id = ${gid2} AND c.user_id = ${newUser} AND m.left_at IS NULL
    `;
    assert(memberNow.rows[0].n === 1, 'new user is now a member');
    const usage = await sql`SELECT used_count FROM group_invite_tokens WHERE token_hash = ${
      // compute hash here to verify
      (await import('node:crypto')).createHash('sha256').update(plaintext).digest('hex')
    }`;
    assert(usage.rows[0].used_count === 1, 'invite usage counter incremented');

    // Bogus token rejected.
    const badAcc = mkRes();
    await acceptInvite(ownerReq({
      method: 'POST', cookie: newCookie, body: { token: 'not-a-real-token' },
    }), badAcc);
    assert(badAcc.statusCode === 400, 'bogus invite → 400');

    // Cleanup
    await sql`DELETE FROM group_invite_tokens WHERE workspace_id IN (${ws1}, ${ws2})`;
    await sql`DELETE FROM group_message_mentions WHERE workspace_id IN (${ws1}, ${ws2})`;
    await sql`DELETE FROM group_message_reactions WHERE workspace_id IN (${ws1}, ${ws2})`;
    await sql`DELETE FROM group_messages WHERE workspace_id IN (${ws1}, ${ws2})`;
    await sql`DELETE FROM group_thread_members WHERE workspace_id IN (${ws1}, ${ws2})`;
    await sql`DELETE FROM group_threads WHERE workspace_id IN (${ws1}, ${ws2})`;
    await sql`DELETE FROM clients WHERE workspace_id IN (${ws1}, ${ws2})`;
    await sql`DELETE FROM workspaces WHERE id IN (${ws1}, ${ws2})`;
    await sql`DELETE FROM users WHERE id IN (${owner1}, ${owner2}, ${portalUser}, ${newUser})`;
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run();
