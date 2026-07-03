// Ivy agency tools: set_availability, update_booking_rules, and the extended
// update_settings (timezone/category + the cache-invalidation fix). Confirms
// gating both directions, validation, and that edits bust the settings cache.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/ivy-agency-tools.test.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { executeIvyTool, SENSITIVE_TOOLS } from '../api/_lib/ivyTools.js';
import { fetchCalendarSettings } from '../api/_lib/calendar.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

async function run() {
  try {
    await ensureSchemaApplied();
    const email = `ivy-agency-${Date.now()}@example.com`;
    const ownerId = (await sql`INSERT INTO users (email, password_hash, name) VALUES (${email}, 'x', 'A') RETURNING id`).rows[0].id;
    const workspaceId = (await sql`INSERT INTO workspaces (owner_id) VALUES (${ownerId}) RETURNING id`).rows[0].id;
    await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug) VALUES (${workspaceId}, 'Biz', ${`ag-${Date.now()}`})`;
    const ctx = { workspaceId };
    const settings = async () => (await sql`SELECT availability, timezone, category, min_notice_hours, max_advance_days, slot_fit_service FROM calendar_settings WHERE workspace_id = ${workspaceId}`).rows[0];

    console.log('\n[1] new tools registered sensitive');
    assert(SENSITIVE_TOOLS.has('set_availability'), 'set_availability is sensitive');
    assert(SENSITIVE_TOOLS.has('update_booking_rules'), 'update_booking_rules is sensitive');

    console.log('\n[2] set_availability gating + preset');
    let r = await executeIvyTool('set_availability', { preset: 'weekdays' }, ctx);
    assert(r.needs_confirmation === true, 'gated without confirm');
    assert(/Mon: 9:00 AM-5:00 PM/.test(r.summary || ''), 'summary previews the schedule');
    r = await executeIvyTool('set_availability', { preset: 'weekdays', confirm: true }, ctx);
    assert(r.ok === true && r.days_open === 5, 'weekdays preset writes 5 days');
    let av = (await settings()).availability;
    assert(av['1'] && av['5'] && !av['0'] && !av['6'], 'Mon-Fri open, weekend closed');
    assert(av['1'][0].start === 540 && av['1'][0].end === 1020, 'windows are 9:00-17:00');

    console.log('\n[3] set_availability with explicit day-name windows (normalized to 0-6)');
    r = await executeIvyTool('set_availability', {
      confirm: true, availability: { monday: [{ start: 600, end: 720 }], sat: [{ start: 540, end: 780 }] },
    }, ctx);
    assert(r.ok === true, 'explicit windows accepted');
    av = (await settings()).availability;
    assert(av['1'] && av['6'] && !av['2'], 'day names normalized to 1 (Mon) + 6 (Sat), replaces prior schedule');
    assert(av['1'][0].end === 720, 'Monday window updated to 10:00-12:00');

    console.log('\n[4] set_availability rejects a bad window');
    r = await executeIvyTool('set_availability', { confirm: true, availability: { monday: [{ start: 800, end: 700 }] } }, ctx);
    assert(typeof r.error === 'string' && /start < end/.test(r.error), 'start>=end rejected');

    console.log('\n[5] update_booking_rules writes + validates');
    r = await executeIvyTool('update_booking_rules', {
      confirm: true, min_notice_hours: 48, max_advance_days: 30, slot_fit_service: true,
    }, ctx);
    assert(r.ok === true, 'rules written');
    let s = await settings();
    assert(Number(s.min_notice_hours) === 48 && Number(s.max_advance_days) === 30 && s.slot_fit_service === true, 'rule columns set');
    r = await executeIvyTool('update_booking_rules', { confirm: true, min_notice_hours: 9999 }, ctx);
    assert(typeof r.error === 'string' && /0-720/.test(r.error), 'out-of-range notice rejected');

    console.log('\n[6] update_settings timezone/category + CACHE invalidation');
    // Prime the cache with the current (null) timezone.
    const before = await fetchCalendarSettings(workspaceId);
    assert(!before.timezone, 'timezone starts unset (cached)');
    r = await executeIvyTool('update_settings', { confirm: true, timezone: 'America/Los_Angeles', category: 'Wellness' }, ctx);
    assert(r.ok === true, 'timezone/category written');
    const after = await fetchCalendarSettings(workspaceId); // must reflect the write (cache busted)
    assert(after.timezone === 'America/Los_Angeles', 'settings cache reflects new timezone (invalidation fix)');
    assert((await settings()).category === 'Wellness', 'category written');

    console.log('\n[7] update_settings rejects a non-canonical slug + bad timezone');
    r = await executeIvyTool('update_settings', { confirm: true, slug: '-bad-' }, ctx);
    assert(typeof r.error === 'string', 'leading/trailing-hyphen slug rejected (VALID_HANDLE)');
    r = await executeIvyTool('update_settings', { confirm: true, timezone: 'Not/AZone' }, ctx);
    assert(typeof r.error === 'string' && /timezone/i.test(r.error), 'bad IANA timezone rejected');

    // Cleanup
    await sql`DELETE FROM calendar_settings WHERE workspace_id = ${workspaceId}`;
    await sql`DELETE FROM workspaces WHERE id = ${workspaceId}`;
    await sql`DELETE FROM users WHERE id = ${ownerId}`;
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run();
