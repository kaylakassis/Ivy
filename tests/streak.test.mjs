// Tests api/_lib/streak.js touchStreak: advances the consecutive-active-days
// count in the workspace timezone, is idempotent within a day, resets after a
// gap, and reports a milestone crossing. Uses tz='UTC' so "today" == CURRENT_DATE.
//
// Run with: node --import ./tests/bootstrap.mjs ./tests/streak.test.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { touchStreak } from '../api/_lib/streak.js';
import { invalidateCalendarSettings } from '../api/_lib/calendar.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

async function run() {
  try {
    await ensureSchemaApplied();
    const tag = `streak-${Date.now()}`;
    const uid = (await sql`INSERT INTO users (email, password_hash, terms_version, terms_accepted_at)
      VALUES (${`${tag}@example.com`}, 'x', '2026-05-05', NOW()) RETURNING id`).rows[0].id;
    const ws = (await sql`INSERT INTO workspaces (owner_id) VALUES (${uid}) RETURNING id`).rows[0].id;
    await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug, timezone)
      VALUES (${ws}, 'S', ${`${tag}-slug`}, 'UTC')`;
    invalidateCalendarSettings(ws);

    const set = async (days, lastOffset /* null | int days ago */) => {
      if (lastOffset == null) {
        await sql`UPDATE workspaces SET streak_days = ${days}, streak_last_day = NULL WHERE id = ${ws}`;
      } else {
        await sql`UPDATE workspaces SET streak_days = ${days}, streak_last_day = CURRENT_DATE - ${lastOffset}::int WHERE id = ${ws}`;
      }
    };

    console.log('\n[1] first active day → streak = 1');
    await set(0, null);
    let r = await touchStreak(ws);
    assert(r.days === 1 && r.isNewDay === true, `first day → 1 (got ${r.days}, isNewDay ${r.isNewDay})`);

    console.log('\n[2] same day again → no advance (idempotent)');
    r = await touchStreak(ws);
    assert(r.days === 1 && r.isNewDay === false, `same day → still 1, not new (got ${r.days}/${r.isNewDay})`);

    console.log('\n[3] consecutive day → increments');
    await set(1, 1); // last active yesterday
    r = await touchStreak(ws);
    assert(r.days === 2 && r.isNewDay === true, `yesterday+today → 2 (got ${r.days})`);

    console.log('\n[4] gap → resets to 1');
    await set(9, 3); // last active 3 days ago
    r = await touchStreak(ws);
    assert(r.days === 1, `3-day gap → resets to 1 (got ${r.days})`);

    console.log('\n[5] crossing a milestone reports it');
    await set(6, 1); // 6-day streak, last active yesterday → today makes 7
    r = await touchStreak(ws);
    assert(r.days === 7 && r.milestone === 7, `6→7 reports milestone 7 (got days ${r.days}, ms ${r.milestone})`);
    // Non-milestone day reports null.
    await set(7, 1); // → 8, not a milestone
    r = await touchStreak(ws);
    assert(r.days === 8 && r.milestone === null, `7→8 no milestone (got days ${r.days}, ms ${r.milestone})`);

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
