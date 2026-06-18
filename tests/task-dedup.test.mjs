// Tests the duplicate-task fixes for the dashboard "Your list":
//   • create_task dedupes (re-running "draft my week" returns the existing
//     open task instead of piling up copy-paste duplicates)
//   • the one-time cleanup migration collapses pre-existing duplicate OPEN
//     tasks (keep earliest), leaving done/different-title tasks untouched.
//
// Run with:
//   node --import ./tests/bootstrap.mjs ./tests/task-dedup.test.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { executeIvyTool } from '../api/_lib/ivyTools.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

// The exact dedup DELETE shipped in schema.js (kept in sync here so the
// test exercises real cleanup logic without re-running the whole migration).
const CLEANUP_SQL = `
  DELETE FROM tasks t
    USING tasks keep
   WHERE t.done = FALSE AND keep.done = FALSE
     AND t.workspace_id = keep.workspace_id
     AND lower(t.title) = lower(keep.title)
     AND t.client_id IS NOT DISTINCT FROM keep.client_id
     AND (keep.created_at < t.created_at
          OR (keep.created_at = t.created_at AND keep.id < t.id))`;

async function run() {
  await ensureSchemaApplied();
  const tag = `td-${Date.now()}`;
  const uid = (await sql`INSERT INTO users (email, password_hash, terms_version, terms_accepted_at)
    VALUES (${`${tag}@example.com`}, 'x', '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  const wid = (await sql`INSERT INTO workspaces (owner_id) VALUES (${uid}) RETURNING id`).rows[0].id;
  const countOpen = async (title) => (await sql`SELECT COUNT(*)::int n FROM tasks WHERE workspace_id = ${wid} AND lower(title) = lower(${title}) AND done = FALSE`).rows[0].n;

  console.log('\n[1] create_task dedupes at write time');
  const r1 = await executeIvyTool('create_task', { title: 'Follow up with leads' }, { workspaceId: wid });
  const r2 = await executeIvyTool('create_task', { title: 'follow up with leads' }, { workspaceId: wid }); // different case
  assert(r1.task && r2.task, 'both calls return a task');
  assert(r1.task.id === r2.task.id && r2.deduped === true, 'second call returns the SAME task (deduped), case-insensitively');
  assert((await countOpen('Follow up with leads')) === 1, 'only one open task exists');

  console.log('\n[2] cleanup migration collapses pre-existing duplicates');
  // Seed duplicates directly (simulating the old pre-dedup behavior).
  for (let i = 0; i < 3; i++) {
    await sql`INSERT INTO tasks (workspace_id, title, done, source) VALUES (${wid}, 'Prep weekly newsletter', FALSE, 'ivy')`;
  }
  await sql`INSERT INTO tasks (workspace_id, title, done, source) VALUES (${wid}, 'Prep weekly newsletter', TRUE, 'ivy')`;  // a DONE one - must survive
  await sql`INSERT INTO tasks (workspace_id, title, done, source) VALUES (${wid}, 'Order more supplies', FALSE, 'ivy')`;   // distinct - must survive
  assert((await countOpen('Prep weekly newsletter')) === 3, 'seeded 3 open duplicates');

  await sql.query(CLEANUP_SQL);

  assert((await countOpen('Prep weekly newsletter')) === 1, 'duplicates collapsed to 1 open task');
  assert((await sql`SELECT COUNT(*)::int n FROM tasks WHERE workspace_id = ${wid} AND lower(title) = lower('Prep weekly newsletter') AND done = TRUE`).rows[0].n === 1, 'the DONE duplicate is untouched');
  assert((await countOpen('Order more supplies')) === 1, 'a distinct task is untouched');

  // Re-running the cleanup is a no-op (idempotent).
  await sql.query(CLEANUP_SQL);
  assert((await countOpen('Prep weekly newsletter')) === 1, 're-running cleanup changes nothing');

  // Cleanup.
  await sql`DELETE FROM tasks WHERE workspace_id = ${wid}`;
  await sql`DELETE FROM workspaces WHERE id = ${wid}`;
  await sql`DELETE FROM users WHERE id = ${uid}`;

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
