// End-to-end rewards program: launch → rules → auto-detected eligibility →
// confirm (issues redemption + client message) → double-issue guard →
// milestone re-fire → dismiss → spend + referral progress → redemption
// lifecycle (used/undo/manual log/delete) → KPIs → tenant isolation.
// Drives the REAL /api/rewards* handlers with a live DB.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/rewards-program.test.mjs
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import { evictWorkspaceGateCache } from '../api/_lib/workspaceGate.js';
import rewardsIndex from '../api/rewards/index.js';
import rulesHandler from '../api/rewards/rules.js';
import ruleByIdHandler from '../api/rewards/rules/[id].js';
import pendingHandler from '../api/rewards/pending.js';
import confirmHandler from '../api/rewards/confirm.js';
import dismissHandler from '../api/rewards/dismiss.js';
import redemptionsHandler from '../api/rewards/redemptions.js';
import redemptionByIdHandler from '../api/rewards/redemptions/[id].js';
import clientByIdHandler from '../api/clients/[id].js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

// Keep outbound side effects (reward email via Resend) in-process and fast.
const realFetch = globalThis.fetch;
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '{}' });

function mockRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { const key = k.toLowerCase(); if (key === 'set-cookie') { (this.headers[key] ||= []).push(v); } else { this.headers[key] = v; } },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(o) { this.body = o; return this; }, end(s) { this.body = s ?? this.body; return this; },
  };
}
let ipN = 0;
function req({ method = 'GET', body = {}, query = {}, cookie } = {}) {
  ipN++;
  return { method, url: '/test', query, body,
    headers: {
      'content-type': 'application/json', origin: 'http://localhost:3000', host: 'localhost:3000',
      'x-forwarded-for': `198.51.100.${(ipN % 200) + 10}`, ...(cookie ? { cookie } : {}),
    } };
}
async function call(handler, opts) { const r = mockRes(); await handler(req(opts), r); return r; }

const STAMP = Date.now();
let ownerId, workspaceId, cookie;
let owner2Id, workspace2Id, cookie2;
let clientA, clientB, clientC;

async function makeOwner(tag) {
  const u = await sql`INSERT INTO users (email, password_hash, name, email_verified_at)
    VALUES (${`rewards-${tag}-${STAMP}@example.com`}, 'x', ${'Owner ' + tag}, NOW()) RETURNING id`;
  const w = await sql`INSERT INTO workspaces (owner_id, subscription_status, trial_ends_at, onboarded_at)
    VALUES (${u.rows[0].id}, 'trialing', NOW() + INTERVAL '10 days', NOW()) RETURNING id`;
  evictWorkspaceGateCache(w.rows[0].id);
  return { userId: u.rows[0].id, workspaceId: w.rows[0].id, cookie: `ivy_session=${signSession(u.rows[0].id)}` };
}
async function makeClient(wsId, name, email, referredBy = null) {
  const r = await sql`INSERT INTO clients (workspace_id, name, email, referred_by_client_id)
    VALUES (${wsId}, ${name}, ${email}, ${referredBy}) RETURNING id`;
  return r.rows[0].id;
}
async function addBooking(wsId, clientId, name, daysAgo, cancelled = false) {
  await sql`INSERT INTO bookings (workspace_id, client_id, client_name, client_email, date, start_min, end_min, cancelled_at)
    VALUES (${wsId}, ${clientId}, ${name}, 'b@example.com',
            (CURRENT_DATE - ${daysAgo}::int), 600, 660,
            ${cancelled ? new Date().toISOString() : null})`;
}

async function cleanup() {
  for (const id of [ownerId, owner2Id]) {
    if (!id) continue;
    await sql`DELETE FROM workspaces WHERE owner_id = ${id}`.catch(() => {});
    await sql`DELETE FROM users WHERE id = ${id}`.catch(() => {});
  }
}

async function run() {
  try {
    await ensureSchemaApplied();
    ({ userId: ownerId, workspaceId, cookie } = await makeOwner('a'));
    ({ userId: owner2Id, workspaceId: workspace2Id, cookie: cookie2 } = await makeOwner('b'));
    clientA = await makeClient(workspaceId, 'Alice Client', `rw-alice-${STAMP}@example.com`);
    clientB = await makeClient(workspaceId, 'Bob Client', `rw-bob-${STAMP}@example.com`);
    clientC = await makeClient(workspaceId, 'Cara Client', `rw-cara-${STAMP}@example.com`);

    console.log('\n[1] program starts unlaunched, then launches');
    let r = await call(rewardsIndex, { cookie });
    assert(r.statusCode === 200 && r.body.rewards.settings.launched === false, `starts unlaunched (got ${r.statusCode})`);
    r = await call(rewardsIndex, { method: 'PATCH', body: { launched: 'yes' }, cookie });
    assert(r.statusCode === 400, `non-boolean launched rejected (got ${r.statusCode})`);
    r = await call(rewardsIndex, { method: 'PATCH', body: { launched: true }, cookie });
    assert(r.statusCode === 200 && r.body.settings.launched === true, 'PATCH launched=true works');

    console.log('\n[2] visit rule + real bookings → auto-detected pending');
    r = await call(rulesHandler, { method: 'POST', cookie, body: {
      type: 'visit', name: 'Book 3, get 1 free', threshold: 3, rewardText: '1 free session',
    } });
    assert(r.statusCode === 201, `visit rule created (got ${r.statusCode})`);
    const visitRule = r.body.rule;
    // Alice: 3 completed + 1 cancelled + 1 future → exactly at threshold.
    await addBooking(workspaceId, clientA, 'Alice Client', 20);
    await addBooking(workspaceId, clientA, 'Alice Client', 10);
    await addBooking(workspaceId, clientA, 'Alice Client', 2);
    await addBooking(workspaceId, clientA, 'Alice Client', 5, true);   // cancelled - must not count
    await addBooking(workspaceId, clientA, 'Alice Client', -7);        // future - must not count
    await addBooking(workspaceId, clientB, 'Bob Client', 3);           // Bob: 1 visit, below threshold
    r = await call(pendingHandler, { cookie });
    assert(r.statusCode === 200, 'pending endpoint 200');
    const p1 = r.body.pending;
    assert(p1.length === 1 && p1[0].clientId === clientA, `exactly Alice is pending (got ${p1.length})`);
    assert(p1[0].current === 3 && p1[0].earned === 1 && p1[0].pending === 1, `cancelled + future bookings excluded (current=${p1[0]?.current})`);

    console.log('\n[3] confirm issues the reward + notifies the client thread');
    r = await call(confirmHandler, { method: 'POST', cookie, body: { ruleId: visitRule.id, clientId: clientA, validityDays: 14 } });
    assert(r.statusCode === 201, `confirm 201 (got ${r.statusCode}: ${JSON.stringify(r.body)})`);
    assert(r.body.redemption.status === 'issued', 'redemption status issued');
    assert(r.body.messageId, 'client chat message was posted');
    const exp = new Date(r.body.redemption.expiresAt).getTime() - Date.now();
    assert(exp > 13 * 86400e3 && exp < 15 * 86400e3, 'expires ~14 days out');
    const msg = await sql`SELECT m.kind, m.sender, m.text, t.unread_client
      FROM messages m JOIN message_threads t ON t.id = m.thread_id
      WHERE t.workspace_id = ${workspaceId} AND t.client_id = ${clientA}`;
    assert(msg.rows.length === 1 && msg.rows[0].kind === 'reward' && msg.rows[0].sender === 'biz', 'thread message kind=reward from biz');
    assert(msg.rows[0].unread_client === 1, 'client unread counter bumped');
    assert(/1 free session/.test(msg.rows[0].text), 'message contains the reward text');

    console.log('\n[4] double-issue guard + milestone re-fire + dismiss');
    r = await call(confirmHandler, { method: 'POST', cookie, body: { ruleId: visitRule.id, clientId: clientA } });
    assert(r.statusCode === 400, `re-confirm at same milestone blocked (got ${r.statusCode})`);
    r = await call(pendingHandler, { cookie });
    assert(r.body.pending.length === 0, 'pending is clear after confirm');
    // 3 more visits → milestone 2 fires
    await addBooking(workspaceId, clientA, 'Alice Client', 1);
    await addBooking(workspaceId, clientA, 'Alice Client', 1);
    await addBooking(workspaceId, clientA, 'Alice Client', 1);
    r = await call(pendingHandler, { cookie });
    assert(r.body.pending.length === 1 && r.body.pending[0].earned === 2 && r.body.pending[0].pending === 1, 'second milestone re-fires');
    r = await call(dismissHandler, { method: 'POST', cookie, body: { ruleId: visitRule.id, clientId: clientA } });
    assert(r.statusCode === 201 && r.body.redemption.status === 'dismissed', 'dismiss records a dismissed redemption');
    r = await call(pendingHandler, { cookie });
    assert(r.body.pending.length === 0, 'dismissed milestone never re-fires');

    console.log('\n[5] spend rule: paid invoices (with tax/discount) drive progress');
    r = await call(rulesHandler, { method: 'POST', cookie, body: {
      type: 'spend', name: 'Spend $200, get $25 credit', threshold: 200, rewardText: '$25 credit',
    } });
    const spendRule = r.body.rule;
    // Bob: (2×150 - 50) × 1.10 = $275 paid → crosses $200. Draft must not count.
    await sql`INSERT INTO invoices (workspace_id, number, client_id, client_name, items, tax_rate, discount, status)
      VALUES (${workspaceId}, 'INV-RW-1', ${clientB}, 'Bob Client',
              ${JSON.stringify([{ description: 'Session', quantity: 2, rate: 150 }])}::jsonb, 10, 50, 'paid')`;
    await sql`INSERT INTO invoices (workspace_id, number, client_id, client_name, items, status)
      VALUES (${workspaceId}, 'INV-RW-2', ${clientB}, 'Bob Client',
              ${JSON.stringify([{ description: 'Big draft', quantity: 10, rate: 500 }])}::jsonb, 'draft')`;
    r = await call(pendingHandler, { cookie });
    const spendPending = r.body.pending.filter((p) => p.rule.id === spendRule.id);
    assert(spendPending.length === 1 && spendPending[0].clientId === clientB, 'Bob pending on the spend rule');
    assert(Math.abs(spendPending[0].current - 275) < 0.01, `spend math incl. tax/discount ($${spendPending[0]?.current})`);
    r = await call(confirmHandler, { method: 'POST', cookie, body: { ruleId: spendRule.id, clientId: clientB, sendMessage: false } });
    assert(r.statusCode === 201 && r.body.messageId === null, 'sendMessage:false issues silently');

    console.log('\n[6] referral rule: referred_by links drive progress');
    r = await call(rulesHandler, { method: 'POST', cookie, body: {
      type: 'referral', name: 'Refer a friend', threshold: 1, rewardText: '20% off next visit',
    } });
    const refRule = r.body.rule;
    // Record the referral through the same API the client drawer's
    // "Referred by" picker uses - the full product path, not raw SQL.
    r = await call(clientByIdHandler, { method: 'PATCH', cookie, query: { id: clientC }, body: { referredByClientId: clientB } });
    assert(r.statusCode === 200, `PATCH referredByClientId works (got ${r.statusCode})`);
    r = await call(pendingHandler, { cookie });
    const refPending = r.body.pending.filter((p) => p.rule.id === refRule.id);
    assert(refPending.length === 1 && refPending[0].clientId === clientB && refPending[0].current === 1,
      'Bob pending on referral rule (Cara referred by Bob)');

    console.log('\n[7] redemption lifecycle: used → undo → manual log → delete');
    const issued = (await sql`SELECT id FROM reward_redemptions
      WHERE workspace_id = ${workspaceId} AND client_id = ${clientA} AND status = 'issued'`).rows[0];
    r = await call(redemptionByIdHandler, { method: 'PATCH', cookie, query: { id: issued.id }, body: { status: 'used' } });
    assert(r.statusCode === 200 && r.body.redemption.status === 'used' && r.body.redemption.usedAt, 'mark used stamps used_at');
    r = await call(redemptionByIdHandler, { method: 'PATCH', cookie, query: { id: issued.id }, body: { status: 'issued' } });
    assert(r.statusCode === 200 && r.body.redemption.status === 'issued' && !r.body.redemption.usedAt, 'undo clears used_at');
    r = await call(redemptionsHandler, { method: 'POST', cookie, body: { clientId: clientB, rewardText: 'Birthday coffee', notes: 'in person' } });
    assert(r.statusCode === 201, 'manual redemption logged');
    const manualId = r.body.redemption.id;
    r = await call(redemptionByIdHandler, { method: 'DELETE', cookie, query: { id: manualId } });
    assert(r.statusCode === 204, 'redemption record deletable');

    console.log('\n[8] KPIs + full GET payload');
    r = await call(rewardsIndex, { cookie });
    const { kpis, rules, redemptions, pending } = r.body.rewards;
    assert(rules.length === 3, `3 rules listed (got ${rules.length})`);
    assert(kpis.activeMembers === 2, `active members = 2 (Alice + Bob) (got ${kpis.activeMembers})`);
    // 3 rows exist (issued visit + dismissed + issued spend) but KPIs must
    // not count the dismissed one as a redeemed reward.
    assert(kpis.rewardsRedeemed === 2, `dismissed rows excluded from redeemed KPI (got ${kpis.rewardsRedeemed})`);
    assert(redemptions.length === 3, 'redemptions list still shows all rows (incl. dismissed, labeled)');
    assert(pending.length === 1, 'referral eligibility still pending in full payload');

    console.log('\n[9] tenant isolation');
    r = await call(confirmHandler, { method: 'POST', cookie: cookie2, body: { ruleId: visitRule.id, clientId: clientA } });
    assert(r.statusCode === 400, `foreign workspace cannot confirm my rule (got ${r.statusCode})`);
    r = await call(ruleByIdHandler, { method: 'DELETE', cookie: cookie2, query: { id: visitRule.id } });
    assert(r.statusCode === 404, 'foreign workspace cannot delete my rule');
    r = await call(rewardsIndex, { cookie: cookie2 });
    assert(r.body.rewards.rules.length === 0 && r.body.rewards.redemptions.length === 0, "workspace 2 sees none of workspace 1's data");

    console.log('\n[10] deleting a rule keeps the audit trail');
    r = await call(ruleByIdHandler, { method: 'DELETE', cookie, query: { id: spendRule.id } });
    assert(r.statusCode === 204, 'rule deleted');
    const orphan = await sql`SELECT rule_id, reward_text FROM reward_redemptions
      WHERE workspace_id = ${workspaceId} AND client_id = ${clientB} AND reward_text = '$25 credit'`;
    assert(orphan.rows.length === 1 && orphan.rows[0].rule_id === null, 'redemption survives rule deletion (rule_id nulled)');
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  } finally {
    globalThis.fetch = realFetch;
    await cleanup();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run();
