// Tests the recurring-occurrence fix for completion-keyed automations.
// Previously both review-requests and booking_completed workflows matched
// only the SERIES ANCHOR date (b.date), so recurring clients never got
// review requests and never got per-session follow-ups. Both now key off
// completion_log occurrence dates.
//
// Run with:
//   node --import ./tests/bootstrap.mjs ./tests/recurring-completion-automations.test.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { selectDueReviewRequests } from '../api/cron/review-requests.js';
import { evaluateScheduledWorkflows } from '../api/_lib/workflows.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

// Date strings computed the SAME way the queries do (CURRENT_DATE in the
// DB session), so JS-vs-DB timezone can't desync the test.
async function dbDate(offsetDays) {
  return (await sql.query(`SELECT (CURRENT_DATE - ($1 || ' days')::interval)::date::text AS d`, [String(offsetDays)])).rows[0].d;
}

async function run() {
  await ensureSchemaApplied();

  const tag = `rca-${Date.now()}`;
  const owner = (await sql`INSERT INTO users (email, password_hash, terms_version, terms_accepted_at)
    VALUES (${`${tag}@example.com`}, 'x', '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  const wsId = (await sql`INSERT INTO workspaces (owner_id) VALUES (${owner}) RETURNING id`).rows[0].id;
  const clientId = (await sql`INSERT INTO clients (workspace_id, name, email, stage)
    VALUES (${wsId}, 'Reggie Recur', ${`${tag}-c@example.com`}, 'active') RETURNING id`).rows[0].id;

  const anchor = await dbDate(120);   // series started 120 days ago
  const threeAgo = await dbDate(3);   // a completed occurrence 3 days ago (in 2–14 window)
  const oneAgo = await dbDate(1);     // a completed occurrence yesterday
  const tenAgo = await dbDate(10);

  // Recurring booking: anchor date 120 days ago, with completions logged on
  // occurrence dates (NOT the anchor) — the exact shape that used to be missed.
  const recBooking = (await sql.query(
    `INSERT INTO bookings (workspace_id, client_id, client_name, client_email, date, start_min, end_min,
                           recurrence_rule, completion_log)
     VALUES ($1,$2,'Reggie Recur',$3,$4,600,660,'FREQ=WEEKLY',$5::jsonb) RETURNING id`,
    [wsId, clientId, `${tag}-c@example.com`, anchor,
     JSON.stringify({ [threeAgo]: { completedAt: 'x' }, [tenAgo]: { completedAt: 'x' } })],
  )).rows[0].id;

  // Control: a recurring booking whose only completion is OUTSIDE the window
  // (anchor today-ish, completed 1 day ago — too recent for reviews).
  const recentBooking = (await sql.query(
    `INSERT INTO bookings (workspace_id, client_id, client_name, client_email, date, start_min, end_min, completion_log)
     VALUES ($1,$2,'Reggie Recur',$3,$4,600,660,$5::jsonb) RETURNING id`,
    [wsId, clientId, `${tag}-c@example.com`, anchor, JSON.stringify({ [oneAgo]: { completedAt: 'x' } })],
  )).rows[0].id;

  console.log('\n[reviews] recurring occurrence in the 2–14d window is selected by date, not anchor');
  const due = await selectDueReviewRequests();
  const dueRow = due.find((r) => r.id === recBooking);
  assert(!!dueRow, 'recurring booking with a completed occurrence 3d ago IS selected (anchor was 120d ago)');
  assert(!due.some((r) => r.id === recentBooking), 'booking whose only completion is 1d ago is NOT yet due (< 2d)');
  // Email date label uses the most-recent in-window occurrence (3 days ago).
  const completed = dueRow && (dueRow.completed_date instanceof Date
    ? dueRow.completed_date.toISOString().slice(0, 10) : String(dueRow.completed_date).slice(0, 10));
  assert(completed === threeAgo, 'completed_date is the most recent in-window occurrence (3d ago), used in the email');

  console.log('\n[workflows] booking_completed fires per completed occurrence + dedupes per occurrence');
  const wfId = (await sql.query(
    `INSERT INTO workflows (workspace_id, name, trigger_type, trigger_config, actions, enabled)
     VALUES ($1,'Thank you 1d after',$2,$3::jsonb,$4::jsonb,TRUE) RETURNING id`,
    [wsId, 'booking_completed', JSON.stringify({ daysAfter: 1 }),
     JSON.stringify([{ type: 'send_email', config: { subject: 'Thanks', body: 'Thanks for coming' } }])],
  )).rows[0].id;

  // The recentBooking has a completion exactly 1 day ago → daysAfter:1 matches it.
  await evaluateScheduledWorkflows({ limit: 500 });
  const runsAfter1 = async () => (await sql`SELECT context->>'occurrenceDate' AS occ FROM workflow_runs
     WHERE workflow_id = ${wfId} AND context->>'bookingId' = ${recentBooking}`).rows;
  let runs = await runsAfter1();
  assert(runs.length === 1, 'occurrence completed 1d ago fired exactly one run');
  assert(runs[0].occ === oneAgo, 'run is keyed to the occurrence date (yesterday), not the anchor');

  console.log('\n[workflows] re-running the cron does NOT double-fire the same occurrence');
  await evaluateScheduledWorkflows({ limit: 500 });
  runs = await runsAfter1();
  assert(runs.length === 1, 'second cron pass deduped on (booking, occurrence) — still one run');

  // Cleanup.
  await sql`DELETE FROM workflow_runs WHERE workflow_id = ${wfId}`;
  await sql`DELETE FROM workflows WHERE id = ${wfId}`;
  await sql`DELETE FROM bookings WHERE workspace_id = ${wsId}`;
  await sql`DELETE FROM clients WHERE workspace_id = ${wsId}`;
  await sql`DELETE FROM workspaces WHERE id = ${wsId}`;
  await sql`DELETE FROM users WHERE id = ${owner}`;

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
