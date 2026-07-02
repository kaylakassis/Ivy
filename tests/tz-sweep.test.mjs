// Verifies the timezone sweep end-to-end: "today" in the owner's zone drives
// the queries, not the server's UTC. Uses buildBriefing (which counts today's
// bookings via `(NOW() AT TIME ZONE tz)::date`) and asserts a booking dated
// "today in that zone" is counted while its neighbors aren't — across both a
// positive (Kolkata, +5:30) and negative (Los Angeles) offset.
//
// Run with: node --import ./tests/bootstrap.mjs ./tests/tz-sweep.test.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { buildBriefing } from '../api/_lib/ivy.js';
import { todayISOInZone } from '../api/_lib/tz.js';
import { invalidateCalendarSettings } from '../api/_lib/calendar.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

const addDaysISO = (iso, n) => {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
};

async function checkZone(ws, uid, tz) {
  await sql`UPDATE calendar_settings SET timezone = ${tz} WHERE workspace_id = ${ws}`;
  invalidateCalendarSettings(ws); // clear the 30s cache so the new tz is read
  const today = todayISOInZone(tz);
  const cli = (await sql`INSERT INTO clients (workspace_id, name, stage) VALUES (${ws}, 'C', 'active') RETURNING id`).rows[0].id;
  // One booking today-in-zone, one yesterday, one tomorrow.
  for (const [iso, tag] of [[today, 'today'], [addDaysISO(today, -1), 'yday'], [addDaysISO(today, 1), 'tmrw']]) {
    await sql`INSERT INTO bookings (workspace_id, client_id, client_name, client_email, date, start_min, end_min)
      VALUES (${ws}, ${cli}, ${tag}, 'c@example.com', ${iso}, 600, 660)`;
  }
  const b = await buildBriefing(ws);
  assert(b.todaySessions === 1, `${tz}: exactly 1 session counted as today (got ${b.todaySessions})`);
  // Clean up bookings/clients for the next zone.
  await sql`DELETE FROM bookings WHERE workspace_id = ${ws}`;
  await sql`DELETE FROM clients WHERE workspace_id = ${ws}`;
}

async function run() {
  try {
    await ensureSchemaApplied();
    const tag = `tzsweep-${Date.now()}`;
    const uid = (await sql`INSERT INTO users (email, password_hash, terms_version, terms_accepted_at)
      VALUES (${`${tag}@example.com`}, 'x', '2026-05-05', NOW()) RETURNING id`).rows[0].id;
    const ws = (await sql`INSERT INTO workspaces (owner_id) VALUES (${uid}) RETURNING id`).rows[0].id;
    await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug) VALUES (${ws}, 'TZ Co.', ${`${tag}-slug`})`;

    console.log('\n[1] positive offset — Asia/Kolkata (UTC+5:30)');
    await checkZone(ws, uid, 'Asia/Kolkata');

    console.log('\n[2] negative offset — America/Los_Angeles');
    await checkZone(ws, uid, 'America/Los_Angeles');

    console.log('\n[3] UTC baseline');
    await checkZone(ws, uid, 'UTC');

    // Cleanup
    await sql`DELETE FROM calendar_settings WHERE workspace_id = ${ws}`;
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
