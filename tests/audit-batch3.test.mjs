// Tests for Batch-3 audit fixes (automation correctness).
//   #14 smart tasks auto-complete when their triggering activity happens.
//   #6  completion-gated predicate — only ACTUALLY-completed booking
//       occurrences satisfy jsonb_exists(completion_log, date::text), so
//       workflows + review requests no longer fire for no-shows.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/audit-batch3.test.mjs

import { sql } from '../api/_lib/db.js';
import { autoCompleteSmartTasks } from '../api/_lib/goals.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

const createdUsers = [];
async function mkWorkspaceClient() {
  const u = await sql`
    INSERT INTO users (email, password_hash, terms_version, terms_accepted_at)
    VALUES (${`b3-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`}, 'x', '2026-05-05', NOW())
    RETURNING id`;
  createdUsers.push(u.rows[0].id);
  const w = await sql`INSERT INTO workspaces (owner_id) VALUES (${u.rows[0].id}) RETURNING id`;
  const wid = w.rows[0].id;
  const c = await sql`
    INSERT INTO clients (workspace_id, name, email, stage)
    VALUES (${wid}, 'C', ${`c-${Date.now()}@example.com`}, 'active') RETURNING id`;
  return { wid, cid: c.rows[0].id };
}

async function run() {
  try {
    console.log('\n[#14] autoCompleteSmartTasks');
    const { wid, cid } = await mkWorkspaceClient();

    // A 'message-client' task created a minute ago...
    const t1 = await sql`
      INSERT INTO tasks (workspace_id, title, type, client_id, created_at)
      VALUES (${wid}, 'Message client', 'message-client', ${cid}, NOW() - INTERVAL '1 minute')
      RETURNING id`;
    // ...and a generic task that has no auto criteria.
    const tGeneric = await sql`
      INSERT INTO tasks (workspace_id, title, type, created_at)
      VALUES (${wid}, 'Do a thing', 'generic', NOW() - INTERVAL '1 minute')
      RETURNING id`;

    // Before the triggering activity: nothing auto-completes.
    let n = await autoCompleteSmartTasks();
    let r1 = (await sql`SELECT done, completed_auto FROM tasks WHERE id = ${t1.rows[0].id}`).rows[0];
    assert(r1.done === false, 'message-client task NOT completed before a biz message exists');

    // Owner sends a message in the thread → triggering activity exists.
    const th = await sql`INSERT INTO message_threads (workspace_id, client_id) VALUES (${wid}, ${cid}) RETURNING id`;
    await sql`INSERT INTO messages (thread_id, sender, text, created_at) VALUES (${th.rows[0].id}, 'biz', 'hi', NOW())`;

    n = await autoCompleteSmartTasks();
    assert(n >= 1, 'autoCompleteSmartTasks reports it flipped at least one task');
    r1 = (await sql`SELECT done, completed_auto, completed_at FROM tasks WHERE id = ${t1.rows[0].id}`).rows[0];
    assert(r1.done === true && r1.completed_auto === true && r1.completed_at != null,
      'message-client task auto-completes once a biz message exists');

    const rg = (await sql`SELECT done FROM tasks WHERE id = ${tGeneric.rows[0].id}`).rows[0];
    assert(rg.done === false, 'generic task is never auto-completed');

    console.log('\n[#6] completion-gate predicate (workflows + review requests)');
    const DATE = '2030-03-10';
    const done = await sql`
      INSERT INTO bookings (workspace_id, client_name, client_email, date, start_min, end_min, completion_log)
      VALUES (${wid}, 'A', 'a@example.com', ${DATE}, 600, 660,
              ${JSON.stringify({ [DATE]: { completedAt: new Date().toISOString() } })}::jsonb)
      RETURNING id`;
    const notDone = await sql`
      INSERT INTO bookings (workspace_id, client_name, client_email, date, start_min, end_min)
      VALUES (${wid}, 'B', 'b@example.com', ${DATE}, 700, 760)
      RETURNING id`;

    const gated = await sql`
      SELECT id FROM bookings
       WHERE workspace_id = ${wid} AND date = ${DATE}
         AND jsonb_exists(completion_log, date::text)`;
    const ids = gated.rows.map((r) => r.id);
    assert(ids.includes(done.rows[0].id), 'completed occurrence passes the gate');
    assert(!ids.includes(notDone.rows[0].id), 'un-completed occurrence (e.g. no-show) is excluded');
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  } finally {
    for (const id of createdUsers) {
      await sql`DELETE FROM workspaces WHERE owner_id = ${id}`.catch(() => {});
      await sql`DELETE FROM users WHERE id = ${id}`.catch(() => {});
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run();
