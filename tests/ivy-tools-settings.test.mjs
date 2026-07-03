// New Ivy tools: update_settings + block_calendar_time. Confirms
//   • Both are gated SENSITIVE — first call returns needs_confirmation.
//   • A confirmed update_settings actually writes the selected
//     calendar_settings columns (and only the supplied ones).
//   • Validation rejects bogus slug, accent color, slot_minutes.
//   • block_calendar_time inserts a calendar_blocks row.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/ivy-tools-settings.test.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { executeIvyTool, SENSITIVE_TOOLS } from '../api/_lib/ivyTools.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

let ownerId, workspaceId;
const EMAIL = `ivy-tools-${Date.now()}@example.com`;

async function run() {
  try {
    await ensureSchemaApplied();
    await sql`DELETE FROM users WHERE email = ${EMAIL}`;
    ownerId = (await sql`INSERT INTO users (email, password_hash, name) VALUES (${EMAIL}, 'x', 'Tools') RETURNING id`).rows[0].id;
    workspaceId = (await sql`INSERT INTO workspaces (owner_id) VALUES (${ownerId}) RETURNING id`).rows[0].id;
    await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug) VALUES (${workspaceId}, 'Old Name', ${`old-${Date.now()}`})`;

    console.log('\n[1] new tools are registered as sensitive');
    assert(SENSITIVE_TOOLS.has('update_settings'), 'update_settings is sensitive');
    assert(SENSITIVE_TOOLS.has('block_calendar_time'), 'block_calendar_time is sensitive');

    console.log('\n[2] update_settings without confirm returns needs_confirmation');
    let r = await executeIvyTool('update_settings', { business_name: 'New Name' }, { workspaceId });
    assert(r.needs_confirmation === true, 'gated on first call');
    assert(typeof r.summary === 'string' && r.summary.includes('New Name'), 'human-readable summary present');

    console.log('\n[3] confirmed update_settings writes only supplied fields');
    r = await executeIvyTool('update_settings', {
      confirm: true, business_name: 'New Name', tagline: 'Faster bookings', accent_color: '#CFFF50',
    }, { workspaceId });
    assert(r.ok === true, 'returns ok');
    const row = (await sql`SELECT biz_name, slug, tagline, brand_accent_color, slot_minutes FROM calendar_settings WHERE workspace_id = ${workspaceId}`).rows[0];
    assert(row.biz_name === 'New Name', 'business_name written');
    assert(row.tagline === 'Faster bookings', 'tagline written');
    assert(row.brand_accent_color === '#CFFF50', 'accent_color written');
    assert(typeof row.slug === 'string' && row.slug.startsWith('old-'), 'slug untouched (not supplied)');

    console.log('\n[4] validation rejects bogus inputs');
    // executeIvyTool catches and returns { error: msg } rather than throwing,
    // so the model can self-correct on the next turn.
    let res = await executeIvyTool('update_settings', { confirm: true, slug: 'NOT-OK!' }, { workspaceId });
    assert(res?.error && /slug must be/i.test(res.error), 'invalid slug rejected');
    res = await executeIvyTool('update_settings', { confirm: true, accent_color: 'red' }, { workspaceId });
    assert(res?.error && /accent_color must be/i.test(res.error), 'invalid accent_color rejected');
    res = await executeIvyTool('update_settings', { confirm: true, slot_minutes: 7 }, { workspaceId });
    assert(res?.error && /slot.?minutes must be/i.test(res.error), 'invalid slot_minutes rejected');

    console.log('\n[5] block_calendar_time without confirm is gated');
    r = await executeIvyTool('block_calendar_time', { date: '2099-01-15', all_day: true, label: 'Vacation' }, { workspaceId });
    assert(r.needs_confirmation === true, 'gated on first call');
    assert(typeof r.summary === 'string' && /Block off/.test(r.summary), 'summary mentions block');

    console.log('\n[6] confirmed block_calendar_time inserts the row');
    r = await executeIvyTool('block_calendar_time', {
      confirm: true, date: '2099-01-15', all_day: true, label: 'Vacation',
    }, { workspaceId });
    assert(r.ok === true && r.block_id, 'returns ok + block_id');
    const blocks = (await sql`SELECT date, all_day, label FROM calendar_blocks WHERE workspace_id = ${workspaceId}`).rows;
    assert(blocks.length === 1, 'one block inserted');
    assert(blocks[0].all_day === true, 'all_day stored');
    assert(blocks[0].label === 'Vacation', 'label stored');

    console.log('\n[7] block_calendar_time validates the date format');
    res = await executeIvyTool('block_calendar_time', { confirm: true, date: 'tomorrow', all_day: true }, { workspaceId });
    assert(res?.error && /YYYY-MM-DD/.test(res.error), 'bad date rejected');
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  } finally {
    if (workspaceId) {
      await sql`DELETE FROM calendar_blocks WHERE workspace_id = ${workspaceId}`.catch(() => {});
      await sql`DELETE FROM calendar_settings WHERE workspace_id = ${workspaceId}`.catch(() => {});
      await sql`DELETE FROM workspaces WHERE id = ${workspaceId}`.catch(() => {});
      await sql`DELETE FROM users WHERE id = ${ownerId}`.catch(() => {});
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
run();
