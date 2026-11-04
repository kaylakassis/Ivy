// POST /api/website/discard-draft - "Discard changes" in the website editor.
//   [1] owner discards: the draft equals the published version again and
//       the editor's unpublished-changes cue clears
//   [2] the live site is untouched (before and after)
//   [3] another workspace's site is untouched
//   [4] a never-published site gets a clear 400 and keeps its draft
//   [5] cross-site requests are refused; GET is not allowed; signed-out is 401
//   [6] response keeps the GET /api/website shape (old app versions)
//
// Run: node --import ./tests/bootstrap.mjs ./tests/website-discard-draft.test.mjs
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import { loadPublicSite } from '../api/_lib/publicSite.js';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import discardHandler from '../api/website/discard-draft.js';
import publishHandler from '../api/website/publish.js';
import websiteHandler from '../api/website/index.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
const TAG = `wdd${Date.now()}${Math.floor(Math.random() * 1000)}`;

function mockRes() {
  return {
    statusCode: 200, body: null, headers: {},
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
    end() { return this; },
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
    getHeader(k) { return this.headers[String(k).toLowerCase()]; },
  };
}
const page = (id, slug, title, headline) => ({
  id, slug, title, inNav: true,
  sections: [{ id: `s_${id}`, type: 'hero', visible: true, data: { headline } }],
});
const headlines = (r) => (r?.page?.sections || []).map((s) => s.data?.headline);

const createdUsers = [];
async function owner(n) {
  const u = await sql`INSERT INTO users (email, password_hash, terms_version, terms_accepted_at)
    VALUES (${`${TAG}-${n}@example.com`}, 'x', '2026-05-05', NOW()) RETURNING id`;
  createdUsers.push(u.rows[0].id);
  const w = await sql`INSERT INTO workspaces (owner_id) VALUES (${u.rows[0].id}) RETURNING id`;
  return { uid: u.rows[0].id, wid: w.rows[0].id, cookie: `ivy_session=${signSession(u.rows[0].id)}` };
}
const req = (cookie, method = 'POST', extra = {}) => ({
  method, url: '/api/website/discard-draft', query: {},
  headers: { cookie, host: 'www.joinivy.ai', ...extra },
});

async function run() {
  try {
    await ensureSchemaApplied();
    await sql`ALTER TABLE websites ADD COLUMN IF NOT EXISTS published_sections JSONB`;
    await sql`ALTER TABLE websites ADD COLUMN IF NOT EXISTS published_pages JSONB`;

    const a = await owner('a');
    const b = await owner('b');
    const c = await owner('c');
    const handleA = `${TAG}a`;
    const handleB = `${TAG}b`;
    const livePages = [page('home', '', 'Home', 'Live home'), page('ab', 'about', 'About', 'Live about')];
    await sql`INSERT INTO websites (workspace_id, handle, business_name, template, sections, pages, visibility, launched)
      VALUES (${a.wid}, ${handleA}, 'A Biz', 'clean', ${JSON.stringify(livePages[0].sections)}::jsonb, ${JSON.stringify(livePages)}::jsonb, 'public', TRUE)`;
    await sql`INSERT INTO websites (workspace_id, handle, business_name, template, sections, pages, visibility, launched)
      VALUES (${b.wid}, ${handleB}, 'B Biz', 'clean', ${JSON.stringify(livePages[0].sections)}::jsonb, ${JSON.stringify(livePages)}::jsonb, 'public', TRUE)`;

    // Publish both, then edit both drafts.
    for (const o of [a, b]) {
      const r = mockRes();
      await publishHandler({ method: 'POST', headers: { cookie: o.cookie }, url: '/api/website/publish', query: {} }, r);
      assert(r.statusCode === 200, `publish ok (${o === a ? 'A' : 'B'})`);
    }
    const draftPages = [
      page('home', '', 'Home', 'Draft home'),
      { ...page('new', 'new-page', 'New page', 'Draft new page') },
    ];
    for (const o of [a, b]) {
      const r = mockRes();
      await websiteHandler({
        method: 'PUT', url: '/api/website', query: {}, headers: { cookie: o.cookie, host: 'www.joinivy.ai' },
        body: { pages: draftPages, sections: draftPages[0].sections, businessName: o === a ? 'A Biz renamed' : 'B Biz' },
      }, r);
      assert(r.statusCode === 200 && r.body?.website?.hasUnpublishedChanges === true, 'draft edit saved and flagged unpublished');
    }

    const liveBefore = await loadPublicSite({ handle: handleA });
    assert(headlines(liveBefore)[0] === 'Live home', 'before discarding, the live site shows the published content');

    console.log('[1] owner discards');
    let r = mockRes();
    await discardHandler(req(a.cookie, 'POST', { origin: 'https://www.joinivy.ai' }), r);
    assert(r.statusCode === 200 && r.body?.discarded === true, 'discard returns 200');
    const row = (await sql`SELECT sections, pages, published_sections, published_pages, business_name
      FROM websites WHERE workspace_id = ${a.wid}`).rows[0];
    assert(JSON.stringify(row.pages) === JSON.stringify(row.published_pages), 'draft pages equal the published pages');
    assert(JSON.stringify(row.sections) === JSON.stringify(row.published_sections), 'draft sections equal the published sections');
    assert(row.pages.length === 2 && row.pages[1].slug === 'about', 'the page added since publishing is gone, the removed one is back');
    assert(r.body.website.hasUnpublishedChanges === false, 'response says there are no unpublished changes');
    const g = mockRes();
    await websiteHandler({ method: 'GET', url: '/api/website', query: {}, headers: { cookie: a.cookie } }, g);
    assert(g.body?.website?.hasUnpublishedChanges === false, 'GET /api/website agrees afterwards');
    assert(g.body.website.pages[0].sections[0].data.headline === 'Live home', 'editor reloads the published content');

    console.log('[6] response shape');
    const keys = Object.keys(g.body.website).sort().join(',');
    assert(Object.keys(r.body.website).sort().join(',') === keys, 'discard returns the same website shape as GET');

    console.log('[2] live site untouched');
    const live = await loadPublicSite({ handle: handleA });
    assert(JSON.stringify(headlines(live)) === JSON.stringify(['Live home']), 'live home page still shows the published content');
    const liveAbout = await loadPublicSite({ handle: handleA, slug: 'about' });
    assert(liveAbout?.kind === 'ok' && headlines(liveAbout)[0] === 'Live about', 'live About page still exists');
    assert(row.business_name === 'A Biz renamed', 'settings that are not draft-gated are not reverted');

    console.log('[3] other workspaces untouched');
    const rowB = (await sql`SELECT pages FROM websites WHERE workspace_id = ${b.wid}`).rows[0];
    assert(rowB.pages[0].sections[0].data.headline === 'Draft home' && rowB.pages[1].slug === 'new-page',
      "another workspace's draft is untouched");

    console.log('[4] never published');
    const cPages = [page('home', '', 'Home', 'Unpublished draft')];
    await sql`INSERT INTO websites (workspace_id, handle, business_name, template, sections, pages, visibility, launched)
      VALUES (${c.wid}, ${`${TAG}c`}, 'C Biz', 'clean', ${JSON.stringify(cPages[0].sections)}::jsonb, ${JSON.stringify(cPages)}::jsonb, 'public', TRUE)`;
    r = mockRes();
    await discardHandler(req(c.cookie), r);
    assert(r.statusCode === 400 && /not been published/i.test(r.body?.error || ''), 'never-published site gets a clear 400');
    const rowC = (await sql`SELECT pages FROM websites WHERE workspace_id = ${c.wid}`).rows[0];
    assert(rowC.pages[0].sections[0].data.headline === 'Unpublished draft', 'its draft is kept');

    console.log('[5] request checks');
    r = mockRes();
    await discardHandler(req(b.cookie, 'POST', { origin: 'https://evil.example' }), r);
    assert(r.statusCode === 403, 'a cross-site request is refused');
    const rowB2 = (await sql`SELECT pages FROM websites WHERE workspace_id = ${b.wid}`).rows[0];
    assert(rowB2.pages[1]?.slug === 'new-page', 'and changes nothing');
    r = mockRes();
    await discardHandler(req(b.cookie, 'GET'), r);
    assert(r.statusCode === 405, 'GET is not allowed');
    r = mockRes();
    await discardHandler(req('', 'POST'), r);
    assert(r.statusCode === 401, 'signed out is 401');
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  } finally {
    for (const id of createdUsers) {
      await sql`DELETE FROM websites WHERE workspace_id IN (SELECT id FROM workspaces WHERE owner_id = ${id})`.catch(() => {});
      await sql`DELETE FROM workspaces WHERE owner_id = ${id}`.catch(() => {});
      await sql`DELETE FROM users WHERE id = ${id}`.catch(() => {});
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
run();
