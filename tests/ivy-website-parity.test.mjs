// Ivy can do everything the owner can do in the Website editor, on the same
// draft, through the approval card, with the editor's own transforms.
//   [1] move a section Home -> About: held for approval (nothing written),
//       card says exactly what moves where, then the draft equals what the
//       editor's pageTransforms.moveSectionToPage produces (anchor links
//       re-pointed); ledger lines are truthful
//   [2] copy to another page, move onto a new page, reorder, duplicate
//   [3] pages: add, rename / re-slug / SEO, reorder, hide from the menu, remove
//   [4] site settings: look, fonts (validated), SEO
//   [5] publish only after approval; schedule and cancel the schedule
//   [6] discard draft changes, restore a saved version
//   [7] invalid input is refused before any card is shown
//   [8] another workspace can neither read nor change any of it
//
// Run: node --import ./tests/bootstrap.mjs ./tests/ivy-website-parity.test.mjs
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { executeIvyTool, runApprovedTool, ledgerEntry } from '../api/_lib/ivyTools.js';
import { executePendingAction } from '../api/_lib/ivyApproval.js';
import { moveSectionToPage, copySectionToPage } from '../src/features/website/pageTransforms.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
const S = Date.now();

async function owner(tag) {
  const u = await sql`INSERT INTO users (email, password_hash, name, email_verified_at) VALUES (${`ivywp-${tag}-${S}@example.com`}, 'x', 'Owner', NOW()) RETURNING id`;
  const w = await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, onboarded_at) VALUES (${u.rows[0].id}, 'WS', 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`;
  return { userId: u.rows[0].id, workspaceId: w.rows[0].id };
}

const startPages = () => ([
  { id: 'home', slug: '', title: 'Home', inNav: true, sections: [
    { id: 'hero', type: 'hero', visible: true, data: { headline: 'Hi there', ctaLink: '#gallery', cta: 'See my work' } },
    { id: 'gal', type: 'gallery', visible: true, data: { title: 'Recent work', images: [] } },
    { id: 'faq', type: 'faq', visible: true, data: { headline: 'Questions' } },
    { id: 'foot', type: 'footer', visible: true, data: {} },
  ] },
  { id: 'about', slug: 'about', title: 'About', inNav: true, sections: [
    { id: 'ab', type: 'about', visible: true, data: { headline: 'Me' } },
  ] },
]);

async function draft(ws) {
  return (await sql`SELECT pages, sections FROM websites WHERE workspace_id = ${ws}`).rows[0];
}
// Stored as jsonb, so key order is the database's: compare by value.
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));
const pageOf = (pages, slug) => pages.find((p) => (p.slug || '') === slug);
const ids = (pages, slug) => pageOf(pages, slug).sections.map((s) => s.id);

async function run() {
  await ensureSchemaApplied();
  const A = await owner('a');
  const B = await owner('b');
  const ctx = { workspaceId: A.workspaceId, userId: A.userId, sessionId: null };
  const ctxB = { workspaceId: B.workspaceId, userId: B.userId };
  await sql`INSERT INTO websites (workspace_id, handle, business_name, pages, sections)
            VALUES (${A.workspaceId}, ${`parity-${S}`}, 'Parity Studio', ${JSON.stringify(startPages())}::jsonb, ${JSON.stringify(startPages()[0].sections)}::jsonb)`;

  // Hold, check nothing was written, then approve.
  async function gated(name, args, label) {
    const before = JSON.stringify(await draft(A.workspaceId));
    const held = await executeIvyTool(name, args, ctx);
    const after = JSON.stringify(await draft(A.workspaceId));
    assert(held.needs_confirmation === true && before === after, `${label}: held for approval, nothing written`);
    const done = await runApprovedTool(name, args, ctx);
    return { held, done };
  }

  console.log('[1] move a section Home -> About');
  {
    const before = (await draft(A.workspaceId)).pages;
    const expected = moveSectionToPage(before, 'gal', 'about', 'bottom');
    const args = { action: 'move_to_page', section_id: 'gal', target_page: 'about' };
    const { held, done } = await gated('edit_website_section', args, 'move_to_page');
    assert(/^Move 'Gallery' \("Recent work"\) from Home to About \(bottom\)/.test(held.summary), `card: ${held.summary}`);
    assert(/1 button on Home that pointed to it will open the About page instead/.test(held.summary), 'card says the button gets re-pointed');
    const w = ledgerEntry('edit_website_section', args, held);
    assert(w.status === 'waiting' && w.summary === held.summary, 'ledger: waiting entry repeats the card');
    assert(done.ok === true && done.relinked === 1, 'ran after approval');
    const now = (await draft(A.workspaceId)).pages;
    assert(canon(now) === canon(expected.pages), 'draft equals what the editor transform produces');
    assert(pageOf(now, '').sections[0].data.ctaLink === '#about', 'hero button now opens the About page');
    assert(JSON.stringify((await draft(A.workspaceId)).sections) === JSON.stringify(pageOf(now, '').sections), 'legacy home mirror kept in step');
    const l = ledgerEntry('edit_website_section', args, done);
    assert(l.status === 'done' && /moved 'Gallery' \("Recent work"\) from Home to About/.test(l.summary), `ledger done: ${l.summary}`);
    const [{ n }] = (await sql`SELECT COUNT(*)::int AS n FROM ivy_pending_actions WHERE workspace_id = ${A.workspaceId} AND tool = 'edit_website_section'`).rows;
    assert(n >= 1, 'the held call was recorded as a pending action');
  }

  console.log('[2] copy, new page, reorder, duplicate, hide');
  {
    const before = (await draft(A.workspaceId)).pages;
    const { held, done } = await gated('edit_website_section', { action: 'copy_to_page', section_id: 'faq', target_page: 'about', position: 'top' }, 'copy_to_page');
    assert(/^Copy 'FAQ' \("Questions"\) from Home to About \(top\)/.test(held.summary), `card: ${held.summary}`);
    const now = (await draft(A.workspaceId)).pages;
    const expected = copySectionToPage(before, 'faq', 'about', 'top', () => done.newSectionId);
    assert(canon(now) === canon(expected.pages), 'copy equals the editor transform (fresh id at the top of About)');
    assert(ids(now, '').includes('faq'), 'original stays on Home');

    const r = await gated('edit_website_section', { action: 'move_to_page', section_id: 'faq', new_page_title: 'Questions' }, 'move onto a new page');
    assert(/to Questions \(a new page at \/questions\) \(bottom\)/.test(r.held.summary), `card: ${r.held.summary}`);
    const p2 = (await draft(A.workspaceId)).pages;
    assert(pageOf(p2, 'questions')?.sections.map((s) => s.id).join() === 'faq' && !ids(p2, '').includes('faq'), 'new page holds the moved section');

    const m = await gated('edit_website_section', { action: 'move', section_id: 'foot', position: 'top' }, 'reorder');
    assert(/Move the 'Footer' section on Home to top/.test(m.held.summary), `card: ${m.held.summary}`);
    assert(ids((await draft(A.workspaceId)).pages, '')[0] === 'foot', 'footer moved to the top of Home');
    await runApprovedTool('edit_website_section', { action: 'move', section_id: 'foot', position: 'bottom' }, ctx);
    assert(ids((await draft(A.workspaceId)).pages, '').at(-1) === 'foot', 'and back to the bottom');

    const d = await gated('edit_website_section', { action: 'duplicate', section_id: 'hero' }, 'duplicate');
    const p3 = (await draft(A.workspaceId)).pages;
    assert(ids(p3, '')[1] === d.done.newSectionId && pageOf(p3, '').sections[1].data.headline === 'Hi there', 'copy sits right below the original');
    await gated('edit_website_section', { action: 'remove', section_id: d.done.newSectionId }, 'remove');
    assert(!ids((await draft(A.workspaceId)).pages, '').includes(d.done.newSectionId), 'removed');
    const h = await gated('edit_website_section', { action: 'hide', section_id: 'ab' }, 'hide');
    assert(/Hide the 'About' \("Me"\) section on About/.test(h.held.summary), `card: ${h.held.summary}`);
    const u = await gated('edit_website_section', { action: 'update', section_id: 'hero', data: { headline: 'Hello', ctaLink: 'javascript:alert(1)' } }, 'update fields');
    assert(/headline to "Hello"/.test(u.held.summary), `card: ${u.held.summary}`);
    assert(pageOf((await draft(A.workspaceId)).pages, '').sections[0].data.ctaLink === '#', 'unsafe link is neutralised like the editor PUT');
  }

  console.log('[3] pages');
  {
    const add = await gated('edit_website_page', { action: 'add', slug: 'pricing', title: 'Pricing', section_types: ['hero', 'pricing'] }, 'add page');
    assert(/Add a new page "Pricing" at \/pricing/.test(add.held.summary), `card: ${add.held.summary}`);
    const ren = await gated('edit_website_page', { action: 'rename', slug: 'pricing', title: 'Prices', new_slug: 'prices', meta_title: 'Prices | Parity' }, 'rename + re-slug');
    assert(/rename it to "Prices"; change its address from \/pricing to \/prices/.test(ren.held.summary), `card: ${ren.held.summary}`);
    let p = (await draft(A.workspaceId)).pages;
    assert(pageOf(p, 'prices')?.title === 'Prices' && pageOf(p, 'prices').metaTitle === 'Prices | Parity', 'renamed, re-slugged, SEO title set');
    await gated('edit_website_page', { action: 'move', slug: 'prices', position: 1 }, 'reorder pages');
    p = (await draft(A.workspaceId)).pages;
    assert(p[1].slug === 'prices', 'Prices is now second in the menu');
    await gated('edit_website_page', { action: 'hide_from_nav', slug: 'questions' }, 'hide from menu');
    assert(pageOf((await draft(A.workspaceId)).pages, 'questions').inNav === false, 'hidden from the menu');
    const rm = await gated('edit_website_page', { action: 'remove', slug: 'prices' }, 'remove page');
    assert(/Remove the Prices page \(\/prices\) and its 2 sections/.test(rm.held.summary), `card: ${rm.held.summary}`);
    assert(!pageOf((await draft(A.workspaceId)).pages, 'prices'), 'page removed');
    const r = await executeIvyTool('edit_website_page', { action: 'rename', slug: '', new_slug: 'home' }, ctx);
    assert(/home page's address cannot change/.test(r.error || ''), 'home page cannot be re-slugged');
  }

  console.log('[4] site settings');
  {
    const r = await gated('update_website', { template: 'bold', font_pair: 'playfair_lato', seo_title: 'Parity' }, 'look + fonts + SEO');
    assert(/look to Bold/.test(r.held.summary) && /live site right away/.test(r.held.summary), `card: ${r.held.summary}`);
    const row = (await sql`SELECT template, font_pair, seo_title FROM websites WHERE workspace_id = ${A.workspaceId}`).rows[0];
    assert(row.template === 'bold' && row.font_pair === 'playfair_lato' && row.seo_title === 'Parity', 'settings saved');
    const bad = await executeIvyTool('update_website', { font_pair: 'comic_sans' }, ctx);
    assert(/Unknown font pair/.test(bad.error || ''), 'unknown font pair refused');
  }

  console.log('[5] publish and schedule');
  {
    const held = await executeIvyTool('publish_website', {}, ctx);
    const row0 = (await sql`SELECT launched, published_at FROM websites WHERE workspace_id = ${A.workspaceId}`).rows[0];
    assert(held.needs_confirmation && !row0.launched && !row0.published_at, 'nothing published before approval');
    const pend = (await sql`SELECT * FROM ivy_pending_actions WHERE id = ${held.pending_id}`).rows[0];
    const out = await executePendingAction({ row: pend, workspaceId: A.workspaceId, userId: A.userId });
    assert(out.claimed && out.result.ok && /^Done\. Publish the website draft/.test(out.text), 'the approval card path publishes');
    const row = (await sql`SELECT launched, published_pages, pages FROM websites WHERE workspace_id = ${A.workspaceId}`).rows[0];
    assert(row.launched && JSON.stringify(row.published_pages) === JSON.stringify(row.pages), 'draft is live');
    const vers = (await sql`SELECT COUNT(*)::int AS n FROM website_versions v JOIN websites w ON w.id = v.website_id WHERE w.workspace_id = ${A.workspaceId}`).rows[0].n;
    assert(vers === 1, 'a version was saved on publish');

    const at = new Date(Date.now() + 3 * 86400_000).toISOString();
    const sch = await gated('publish_website', { at }, 'schedule');
    assert(/Schedule the website draft as it is now to go live on/.test(sch.held.summary), `card: ${sch.held.summary}`);
    const s1 = (await sql`SELECT scheduled_publish_at, scheduled_pages FROM websites WHERE workspace_id = ${A.workspaceId}`).rows[0];
    assert(s1.scheduled_publish_at && Array.isArray(s1.scheduled_pages), 'scheduled with a frozen copy of the pages');
    await gated('publish_website', { cancel_schedule: true }, 'cancel schedule');
    const s2 = (await sql`SELECT scheduled_publish_at FROM websites WHERE workspace_id = ${A.workspaceId}`).rows[0];
    assert(!s2.scheduled_publish_at, 'schedule cancelled');
    const past = await executeIvyTool('publish_website', { at: '2020-01-01T00:00:00Z' }, ctx);
    assert(/future/.test(past.error || ''), 'a time in the past is refused');
  }

  console.log('[6] discard draft, restore version');
  {
    await runApprovedTool('edit_website_section', { action: 'remove', section_id: 'hero' }, ctx);
    const r = await gated('restore_website', { action: 'discard_draft' }, 'discard draft');
    assert(/Throw away every website draft change since you last published/.test(r.held.summary), `card: ${r.held.summary}`);
    const row = (await sql`SELECT pages, published_pages FROM websites WHERE workspace_id = ${A.workspaceId}`).rows[0];
    assert(ids(row.pages, '').includes('hero') && JSON.stringify(row.pages) === JSON.stringify(row.published_pages), 'draft is back to what is live');
    const again = await executeIvyTool('restore_website', { action: 'discard_draft' }, ctx);
    assert(/no unpublished changes/.test(again.error || ''), 'nothing to discard is refused');

    const v = (await sql`SELECT v.id, v.snapshot FROM website_versions v JOIN websites w ON w.id = v.website_id WHERE w.workspace_id = ${A.workspaceId} ORDER BY v.created_at ASC LIMIT 1`).rows[0];
    // Change the draft so the restore has something to put back.
    await runApprovedTool('edit_website_page', { action: 'remove', slug: 'about' }, ctx);
    const gw = await executeIvyTool('get_website', {}, ctx);
    assert(gw.versions.some((x) => x.id === v.id), 'get_website lists saved versions');
    const rv = await gated('restore_website', { action: 'restore_version', version_id: v.id }, 'restore version');
    assert(/Put back the website version saved/.test(rv.held.summary), `card: ${rv.held.summary}`);
    const after = (await sql`SELECT pages, template FROM websites WHERE workspace_id = ${A.workspaceId}`).rows[0];
    assert(canon(after.pages) === canon(v.snapshot.pages) && after.template === v.snapshot.template, 'the saved version (pages and look) is back');
    const n = (await sql`SELECT COUNT(*)::int AS n FROM website_versions v JOIN websites w ON w.id = v.website_id WHERE w.workspace_id = ${A.workspaceId}`).rows[0].n;
    assert(n === 2, 'current state saved as a version before restoring');
  }

  console.log('[7] invalid input is refused before any card');
  {
    const cases = [
      [{ action: 'explode', section_id: 'hero' }, /action must be one of/],
      [{ action: 'update', section_id: 'nope' }, /No section with id/],
      [{ action: 'add', page_slug: '', type: 'unicorn' }, /Unknown section type/],
      [{ action: 'add', page_slug: '', type: 'custom_html' }, /only be added by the owner/],
      [{ action: 'move_to_page', section_id: 'hero', target_page: 'nowhere' }, /No page with slug/],
      [{ action: 'move', section_id: 'hero', position: 'sideways' }, /position must be/],
      [{ action: 'update', section_id: 'hero', data: { notAField: 1 } }, /None of those fields/],
    ];
    const before = (await sql`SELECT COUNT(*)::int AS n FROM ivy_pending_actions WHERE workspace_id = ${A.workspaceId}`).rows[0].n;
    for (const [args, re] of cases) {
      // eslint-disable-next-line no-await-in-loop
      const r = await executeIvyTool('edit_website_section', args, ctx);
      assert(re.test(r.error || '') && /Nothing was changed/.test(r.error), `refused: ${JSON.stringify(args)}`);
    }
    const after = (await sql`SELECT COUNT(*)::int AS n FROM ivy_pending_actions WHERE workspace_id = ${A.workspaceId}`).rows[0].n;
    assert(after === before, 'no approval card was recorded for any of them');
  }

  console.log('[8] workspace isolation');
  {
    const r = await executeIvyTool('edit_website_section', { action: 'move_to_page', section_id: 'gal', target_page: 'about' }, ctxB);
    assert(!!r.error && !r.needs_confirmation, "another workspace cannot move this site's section");
    const ran = await runApprovedTool('edit_website_section', { action: 'remove', section_id: 'gal' }, ctxB);
    assert(!!ran.error, 'even an approved call in another workspace finds nothing');
    const v = (await sql`SELECT v.id FROM website_versions v JOIN websites w ON w.id = v.website_id WHERE w.workspace_id = ${A.workspaceId} LIMIT 1`).rows[0];
    const rv = await executeIvyTool('restore_website', { action: 'restore_version', version_id: v.id }, ctxB);
    assert(/version was not found/.test(rv.error || ''), "another workspace cannot restore this site's version");
    const gw = await executeIvyTool('get_website', {}, ctxB);
    assert(gw.website.exists === false && gw.versions.length === 0, 'and sees no site or versions');
    assert(ids((await draft(A.workspaceId)).pages, 'about').includes('gal'), "A's draft untouched");
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
run().catch((e) => { console.error('crashed:', e); process.exit(1); });
