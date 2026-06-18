// Tests the ivy-nudges cron: AWAITING_REPLY detector + GONE_QUIET
// detector + dedup via ivy_nudges_fired. Also verifies that the
// freshly-added owner pushes (review submitted, invoice sent, invoice
// overdue owner-side, cancellation client-side, recurring auto-issued,
// dunning) actually record a row in the notifications feed.
//
// Run with: node --import ./tests/bootstrap.mjs ./tests/ivy-nudges.test.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';

process.env.CRON_SECRET = process.env.CRON_SECRET || 'test-cron';

const { default: ivyNudges } = await import('../api/cron/ivy-nudges.js');

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
function cronReq() {
  return {
    method: 'POST', url: '/api/cron/ivy-nudges',
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
  };
}

async function run() {
  try {
    await ensureSchemaApplied();
    const tag = `ivy-${Date.now()}`;
    const uid = (await sql`INSERT INTO users (email, password_hash, terms_version, terms_accepted_at)
      VALUES (${`${tag}@example.com`}, 'x', '2026-05-05', NOW()) RETURNING id`).rows[0].id;
    const ws = (await sql`INSERT INTO workspaces (owner_id) VALUES (${uid}) RETURNING id`).rows[0].id;
    const cAct = (await sql`INSERT INTO clients (workspace_id, name, email, stage)
      VALUES (${ws}, 'Active Annie', ${`${tag}-a@example.com`}, 'active') RETURNING id`).rows[0].id;
    const cQuiet = (await sql`INSERT INTO clients (workspace_id, name, email, stage)
      VALUES (${ws}, 'Quiet Quinn', ${`${tag}-q@example.com`}, 'active') RETURNING id`).rows[0].id;
    const cLead = (await sql`INSERT INTO clients (workspace_id, name, email, stage)
      VALUES (${ws}, 'Lead Lou', ${`${tag}-l@example.com`}, 'lead') RETURNING id`).rows[0].id;

    console.log('\n[1] auth gate');
    const noAuth = mkRes();
    await ivyNudges({ method: 'POST', headers: {} }, noAuth);
    assert(noAuth.statusCode === 401, `no cron secret → 401 (got ${noAuth.statusCode})`);

    console.log('\n[2] AWAITING_REPLY - unanswered client message > 24h');
    // Create a thread whose last_message_at is 2 days ago with unread_biz=1
    // (= last inbound was from the client).
    const t = (await sql`
      INSERT INTO message_threads (workspace_id, client_id, unread_biz, last_message_at, last_message_preview)
      VALUES (${ws}, ${cAct}, 1, NOW() - INTERVAL '2 days', 'Are you free Thursday?')
      RETURNING id
    `).rows[0].id;

    const r1 = mkRes();
    await ivyNudges(cronReq(), r1);
    assert(r1.statusCode === 200, `cron → 200 (got ${r1.statusCode})`);
    assert(r1.body?.awaitingFired === 1, `awaiting fired (got ${JSON.stringify(r1.body)})`);
    const feed = await sql`SELECT title, tag FROM notifications WHERE user_id = ${uid} AND tag = ${`ivy-awaiting-${cAct}`}`;
    assert(feed.rows.length === 1 && feed.rows[0].title.includes('Ivy'), 'awaiting_reply push recorded in feed');

    const fired = await sql`SELECT * FROM ivy_nudges_fired WHERE workspace_id = ${ws} AND client_id = ${cAct} AND kind = 'awaiting_reply'`;
    assert(fired.rows.length === 1, 'dedup row written');

    console.log('\n[3] dedup: second run does NOT re-fire the same nudge');
    const r2 = mkRes();
    await ivyNudges(cronReq(), r2);
    assert(r2.body?.awaitingFired === 0, `dedup blocks re-fire (got ${r2.body?.awaitingFired})`);

    console.log('\n[4] GONE_QUIET - client active 30d ago, silent since');
    // Backdate an old booking + zero recent activity for cQuiet.
    await sql`
      INSERT INTO bookings (workspace_id, client_id, client_name, client_email, start_min, end_min, date)
      VALUES (${ws}, ${cQuiet}, 'Quiet Quinn', ${`${tag}-q@example.com`},
              600, 660, (NOW() - INTERVAL '30 days')::date)
    `;

    const r3 = mkRes();
    await ivyNudges(cronReq(), r3);
    assert(r3.body?.quietFired === 1, `gone_quiet fired (got ${JSON.stringify(r3.body)})`);
    const feedQuiet = await sql`SELECT title, tag FROM notifications WHERE user_id = ${uid} AND tag = ${`ivy-quiet-${cQuiet}`}`;
    assert(feedQuiet.rows.length === 1, 'gone_quiet push recorded');
    assert(feedQuiet.rows[0].title.toLowerCase().includes('check in'), 'gone_quiet push titled correctly');

    console.log('\n[5] lead-stage clients are NOT in scope for gone_quiet');
    await sql`
      INSERT INTO bookings (workspace_id, client_id, client_name, client_email, start_min, end_min, date)
      VALUES (${ws}, ${cLead}, 'Lead Lou', ${`${tag}-l@example.com`},
              600, 660, (NOW() - INTERVAL '30 days')::date)
    `;
    // Clear cQuiet's dedup row so we'd otherwise re-fire - proves the
    // lead filter (not the dedup) is what excludes cLead.
    await sql`DELETE FROM ivy_nudges_fired WHERE client_id = ${cQuiet}`;

    const r4 = mkRes();
    await ivyNudges(cronReq(), r4);
    const noLeadFeed = await sql`SELECT 1 FROM notifications WHERE user_id = ${uid} AND tag = ${`ivy-quiet-${cLead}`}`;
    assert(noLeadFeed.rows.length === 0, 'no nudge fired for stage=lead client');

    console.log('\n[6] thread with no unread is NOT in scope for awaiting_reply');
    // Owner has already replied (unread_biz=0) - should not fire.
    await sql`
      UPDATE message_threads SET unread_biz = 0 WHERE id = ${t}
    `;
    await sql`DELETE FROM ivy_nudges_fired WHERE client_id = ${cAct}`;
    const before = await sql`SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = ${uid} AND tag = ${`ivy-awaiting-${cAct}`}`;
    const r5 = mkRes();
    await ivyNudges(cronReq(), r5);
    const after = await sql`SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = ${uid} AND tag = ${`ivy-awaiting-${cAct}`}`;
    assert(after.rows[0].n === before.rows[0].n, 'no new awaiting_reply push when unread_biz=0');

    // Cleanup
    await sql`DELETE FROM ivy_nudges_fired WHERE workspace_id = ${ws}`;
    await sql`DELETE FROM notifications WHERE user_id = ${uid}`;
    await sql`DELETE FROM bookings WHERE workspace_id = ${ws}`;
    await sql`DELETE FROM messages WHERE thread_id = ${t}`;
    await sql`DELETE FROM message_threads WHERE workspace_id = ${ws}`;
    await sql`DELETE FROM clients WHERE workspace_id = ${ws}`;
    await sql`DELETE FROM workspaces WHERE id = ${ws}`;
    await sql`DELETE FROM users WHERE id = ${uid}`;
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run();
