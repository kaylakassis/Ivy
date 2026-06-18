// Tests for the booking-reminders scan after the scaling fix: the old
// handler used a single `LIMIT 5000` scan that silently dropped reminders
// for every booking past the first 5000 in the 8-day window. It now uses a
// keyset-paginated query (fetchDueBookings) with a SQL pre-filter that only
// returns bookings with a reminder beat landing near now.
//
// These tests assert the SELECTION + CURSOR behavior directly - i.e. that
// due bookings are returned, not-due / ineligible / cancelled ones are
// excluded, and the keyset cursor pages forward without dropping rows.
//
// Run with:
//   node --import ./tests/bootstrap.mjs ./tests/booking-reminders.test.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { fetchDueBookings } from '../api/cron/booking-reminders.js';

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { pass++; console.log('  ✓', label); }
  else      { fail++; console.log('  ✗', label); }
}

const tag = `br-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// date (YYYY-MM-DD, UTC) + minutes-of-day for an instant `msFromNow` from
// now - matches how the query reconstructs a booking's UTC start.
function dateAndMin(msFromNow) {
  const d = new Date(Date.now() + msFromNow);
  return { date: d.toISOString().slice(0, 10), startMin: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

async function mkBooking({ workspaceId, serviceId, msFromNow, email = `${tag}@example.com`, cancelled = false }) {
  const { date, startMin } = dateAndMin(msFromNow);
  const r = await sql.query(
    `INSERT INTO bookings (workspace_id, service_id, client_name, client_email, date, start_min, end_min, cancelled_at)
     VALUES ($1, $2, 'T', $3, $4, $5, $6, ${cancelled ? 'NOW()' : 'NULL'})
     RETURNING id`,
    [workspaceId, serviceId, email, date, startMin, startMin + 30],
  );
  return r.rows[0].id;
}

async function run() {
  await ensureSchemaApplied();

  const owner = (await sql`
    INSERT INTO users (email, password_hash, terms_version, terms_accepted_at)
    VALUES (${`${tag}-owner@example.com`}, 'x', '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  const workspaceId = (await sql`INSERT INTO workspaces (owner_id) VALUES (${owner}) RETURNING id`).rows[0].id;
  // Service with a 2-hour (120 min) reminder beat.
  const serviceId = (await sql.query(
    `INSERT INTO services (workspace_id, name, duration_minutes, capacity, reminder_minutes)
     VALUES ($1, 'R', 60, 1, $2::int[]) RETURNING id`,
    [workspaceId, [120]],
  )).rows[0].id;
  // Service with NO reminder beats - bookings under it should never appear.
  const noBeatService = (await sql.query(
    `INSERT INTO services (workspace_id, name, duration_minutes, capacity, reminder_minutes)
     VALUES ($1, 'N', 60, 1, $2::int[]) RETURNING id`,
    [workspaceId, []],
  )).rows[0].id;

  const TWO_H = 120 * 60 * 1000;
  const SEVEN_D = 7 * 24 * 60 * 60 * 1000;

  console.log('\n[1] selection: only the due, eligible, non-cancelled booking is returned');
  // Due: starts in ~2h → the 120-min beat target is ~now (inside window).
  const due = await mkBooking({ workspaceId, serviceId, msFromNow: TWO_H });
  // Not due: starts in 7 days → 120-min beat target is far from now.
  const future = await mkBooking({ workspaceId, serviceId, msFromNow: SEVEN_D });
  // Ineligible: no email and no SMS consent.
  const noContact = await mkBooking({ workspaceId, serviceId, msFromNow: TWO_H, email: '' });
  // Cancelled: due-timed but cancelled.
  const cancelled = await mkBooking({ workspaceId, serviceId, msFromNow: TWO_H, cancelled: true });
  // No-beat service: due-timed but the service has no reminder_minutes.
  const noBeat = await mkBooking({ workspaceId, serviceId: noBeatService, msFromNow: TWO_H });

  const { rows } = await fetchDueBookings(null);
  const ids = new Set(rows.map((r) => r.id));
  assert(ids.has(due), 'due booking is selected');
  assert(!ids.has(future), 'far-future booking is excluded by the time pre-filter');
  assert(!ids.has(noContact), 'booking with no email/SMS consent is excluded');
  assert(!ids.has(cancelled), 'cancelled booking is excluded');
  assert(!ids.has(noBeat), 'booking under a service with no reminder beats is excluded');

  console.log('\n[2] keyset cursor pages forward without dropping or repeating');
  // A second due booking, ordered after `due` by (date, start_min, id).
  const due2 = await mkBooking({ workspaceId, serviceId, msFromNow: TWO_H + 60 * 1000 });
  const all = (await fetchDueBookings(null)).rows;
  assert(all.some((r) => r.id === due) && all.some((r) => r.id === due2), 'both due bookings present without a cursor');

  // Find `due`'s sort key, page AFTER it, and confirm `due` is excluded.
  const dueRow = all.find((r) => r.id === due);
  const afterDue = (await fetchDueBookings({ date: dueRow.date, startMin: dueRow.start_min, id: dueRow.id })).rows;
  assert(!afterDue.some((r) => r.id === due), 'cursor is exclusive - the cursor row itself is not re-returned');

  // Paging from the very last row returns nothing (clean termination).
  const lastRow = all[all.length - 1];
  const afterLast = (await fetchDueBookings({ date: lastRow.date, startMin: lastRow.start_min, id: lastRow.id })).rows;
  assert(afterLast.every((r) => !ids.has(r.id) && r.id !== due2), 'paging past the last due row yields no earlier rows again');

  // Cleanup.
  await sql`DELETE FROM bookings WHERE workspace_id = ${workspaceId}`;
  await sql`DELETE FROM services WHERE workspace_id = ${workspaceId}`;
  await sql`DELETE FROM workspaces WHERE id = ${workspaceId}`;
  await sql`DELETE FROM users WHERE id = ${owner}`;

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
