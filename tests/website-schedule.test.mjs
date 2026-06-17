// Test for #17 — scheduled publish (now reachable + correct under #7).
//   • PUT can SET and CLEAR a schedule (the old COALESCE blocked clearing).
//   • The cron promotes scheduled content into the published_* snapshot so
//     it actually goes live (publicSite reads published_*).
//
// Run: node --import ./tests/bootstrap.mjs ./tests/website-schedule.test.mjs

import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import { loadPublicSite } from '../api/_lib/publicSite.js';
import websiteHandler from '../api/website/index.js';
import cron from '../api/cron/scheduled-publish.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
function mockRes() {
  const r = { statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; },
    setHeader() {}, end() { return this; } };
  return r;
}
const sect = (id) => [{ id, type: 'hero', visible: true, data: { headline: id } }];
const page = (id) => [{ id: 'h', slug: '', title: 'Home', sections: sect(id), inNav: true }];
const liveIds = async (handle) => ((await loadPublicSite({ handle }))?.page?.sections || []).map((s) => s.id);

const createdUsers = [];
async function run() {
  try {
    await sql`ALTER TABLE websites ADD COLUMN IF NOT EXISTS published_sections JSONB`;
    await sql`ALTER TABLE websites ADD COLUMN IF NOT EXISTS published_pages JSONB`;
    process.env.CRON_SECRET ||= 'test-cron-secret';

    const u = await sql`INSERT INTO users (email, password_hash, terms_version, terms_accepted_at)
      VALUES (${`ws-${Date.now()}@example.com`}, 'x', '2026-05-05', NOW()) RETURNING id`;
    createdUsers.push(u.rows[0].id);
    const uid = u.rows[0].id;
    const wid = (await sql`INSERT INTO workspaces (owner_id) VALUES (${uid}) RETURNING id`).rows[0].id;
    const handle = `s${Date.now()}`;

    // Already-published site serving OLD.
    await sql`INSERT INTO websites (workspace_id, handle, business_name, template, sections, pages,
                published_sections, published_pages, visibility, published_at, launched)
      VALUES (${wid}, ${handle}, 'Biz', 'clean',
              ${JSON.stringify(sect('OLD'))}::jsonb, ${JSON.stringify(page('OLD'))}::jsonb,
              ${JSON.stringify(sect('OLD'))}::jsonb, ${JSON.stringify(page('OLD'))}::jsonb,
              'public', NOW(), TRUE)`;
    assert((await liveIds(handle)).includes('OLD'), 'live site serves OLD');

    const cookie = `ivy_session=${signSession(uid)}`;
    const put = async (body) => { const r = mockRes(); await websiteHandler({ method: 'PUT', headers: { cookie }, url: '/api/website', query: {}, body }, r); return r; };

    // SET a schedule (future) with NEW content staged.
    const future = new Date(Date.now() + 3600_000).toISOString();
    await put({ scheduledPublishAt: future, scheduledPages: page('NEW') });
    let row = (await sql`SELECT scheduled_publish_at, scheduled_pages FROM websites WHERE workspace_id = ${wid}`).rows[0];
    assert(row.scheduled_publish_at != null, 'schedule is set');
    assert((await liveIds(handle)).includes('OLD'), 'live still OLD before the scheduled time');

    // CLEAR the schedule (this was impossible with the old COALESCE).
    await put({ scheduledPublishAt: null, scheduledPages: null });
    row = (await sql`SELECT scheduled_publish_at FROM websites WHERE workspace_id = ${wid}`).rows[0];
    assert(row.scheduled_publish_at == null, 'schedule can be CLEARED');

    // Re-schedule in the PAST so the cron fires it.
    await sql`UPDATE websites SET scheduled_publish_at = NOW() - INTERVAL '1 minute',
                scheduled_pages = ${JSON.stringify(page('NEW'))}::jsonb WHERE workspace_id = ${wid}`;
    const cr = mockRes();
    await cron({ method: 'POST', headers: { authorization: `Bearer ${process.env.CRON_SECRET}` }, query: {} }, cr);
    assert(cr.statusCode === 200 && cr.body?.fired >= 1, 'cron fired the due schedule');

    // It actually went live (published snapshot updated) + schedule cleared.
    assert((await liveIds(handle)).includes('NEW'), 'after cron, live site serves NEW (published snapshot updated)');
    row = (await sql`SELECT scheduled_publish_at FROM websites WHERE workspace_id = ${wid}`).rows[0];
    assert(row.scheduled_publish_at == null, 'schedule cleared after firing');
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
