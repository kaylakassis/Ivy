// Test for #7 - website draft/publish separation.
//   • Draft edits do NOT leak to the live site until Publish.
//   • Publish snapshots the draft into published_sections/_pages.
//   • Already-published sites (NULL published_*) fall back to live.
//   • The website API exposes hasUnpublishedChanges (the editor cue).
//
// Run: node --import ./tests/bootstrap.mjs ./tests/website-publish.test.mjs

import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import { loadPublicSite } from '../api/_lib/publicSite.js';
import publishHandler from '../api/website/publish.js';
import websiteHandler from '../api/website/index.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

function mockRes() {
  const res = { statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; }, end() { return this; }, setHeader() {} };
  return res;
}
const sect = (id) => [{ id, type: 'hero', visible: true, data: { headline: id } }];
const ids = (r) => (r?.page?.sections || []).map((s) => s.id);

const createdUsers = [];
async function run() {
  try {
    // Columns may not exist in the already-migrated test DB (probe passes,
    // so the full migration won't re-run) - apply them idempotently.
    await sql`ALTER TABLE websites ADD COLUMN IF NOT EXISTS published_sections JSONB`;
    await sql`ALTER TABLE websites ADD COLUMN IF NOT EXISTS published_pages JSONB`;

    const u = await sql`INSERT INTO users (email, password_hash, terms_version, terms_accepted_at)
      VALUES (${`wp-${Date.now()}@example.com`}, 'x', '2026-05-05', NOW()) RETURNING id`;
    createdUsers.push(u.rows[0].id);
    const uid = u.rows[0].id;
    const w = await sql`INSERT INTO workspaces (owner_id) VALUES (${uid}) RETURNING id`;
    const wid = w.rows[0].id;
    const handle = `t${Date.now()}`;

    await sql`INSERT INTO websites (workspace_id, handle, business_name, template, sections, pages, visibility)
      VALUES (${wid}, ${handle}, 'Biz', 'clean', ${JSON.stringify(sect('A'))}::jsonb, '[]'::jsonb, 'public')`;

    const cookie = `ivy_session=${signSession(uid)}`;
    const pubReq = () => ({ method: 'POST', headers: { cookie }, url: '/api/website/publish', query: {} });

    // Not published yet → public reader returns not_found.
    assert((await loadPublicSite({ handle })).kind === 'not_found', 'unpublished site is not public');

    // Publish → snapshots draft A into published_*.
    let r = mockRes(); await publishHandler(pubReq(), r);
    assert(r.statusCode === 200, 'publish returns 200');
    assert(ids(await loadPublicSite({ handle })).includes('A'), 'after publish, live shows A');

    // Edit the DRAFT to B (what the editor auto-save does).
    await sql`UPDATE websites SET sections = ${JSON.stringify(sect('B'))}::jsonb WHERE workspace_id = ${wid}`;

    // The live site must STILL show A - the draft edit must not leak.
    const liveAfterEdit = ids(await loadPublicSite({ handle }));
    assert(liveAfterEdit.includes('A') && !liveAfterEdit.includes('B'),
      'draft edit (B) does NOT leak to the live site (still A)');

    // The API surfaces the unpublished-changes cue.
    const gReq = { method: 'GET', headers: { cookie }, url: '/api/website', query: {} };
    const gRes = mockRes(); await websiteHandler(gReq, gRes);
    assert(gRes.body?.website?.hasUnpublishedChanges === true, 'API reports hasUnpublishedChanges after a draft edit');

    // Republish → B goes live and the cue clears.
    r = mockRes(); await publishHandler(pubReq(), r);
    assert(ids(await loadPublicSite({ handle })).includes('B'), 'after republish, live shows B');
    const gRes2 = mockRes(); await websiteHandler({ ...gReq }, gRes2);
    assert(gRes2.body?.website?.hasUnpublishedChanges === false, 'cue clears after republish');

    // Backward-safe: a site with NULL published_* falls back to live.
    await sql`UPDATE websites SET published_sections = NULL, published_pages = NULL WHERE workspace_id = ${wid}`;
    assert(ids(await loadPublicSite({ handle })).includes('B'), 'NULL published_* falls back to the live columns');
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
