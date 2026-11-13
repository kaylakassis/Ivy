// Ivy builds, edits and publishes the owner's website.
// Run: node --import ./tests/bootstrap.mjs ./tests/ivy-website-tools.test.mjs
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { executeIvyTool, runApprovedTool, IVY_TOOLS, SENSITIVE_TOOLS } from '../api/_lib/ivyTools.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
const S = Date.now();

async function owner(tag) {
  const u = await sql`INSERT INTO users (email, password_hash, name, email_verified_at) VALUES (${`ivyweb-${tag}-${S}@example.com`}, 'x', 'Owner', NOW()) RETURNING id`;
  const w = await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, onboarded_at) VALUES (${u.rows[0].id}, 'WS', 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`;
  return { userId: u.rows[0].id, workspaceId: w.rows[0].id };
}

async function run() {
  await ensureSchemaApplied();
  const a = await owner('a');
  const b = await owner('b');
  const ctx = { workspaceId: a.workspaceId };

  console.log('\n[1] tools are registered and gated');
  const names = new Set(IVY_TOOLS.map((t) => t.name));
  assert(['get_website', 'create_website', 'edit_website_section', 'edit_website_page', 'update_website', 'publish_website'].every((n) => names.has(n)), 'six website tools exposed to the model');
  assert(['create_website', 'edit_website_section', 'edit_website_page', 'update_website', 'publish_website', 'restore_website'].every((n) => SENSITIVE_TOOLS.has(n)) && !SENSITIVE_TOOLS.has('get_website'), 'every website write needs approval; reading does not');

  console.log('\n[2] get_website on a fresh workspace');
  let r = await executeIvyTool('get_website', {}, ctx);
  assert(r.website && r.website.exists === false, 'reports no site yet');
  assert(Array.isArray(r.templatePacks) && r.templatePacks.some((p) => p.id === 'creative_studio'), 'lists template packs');
  assert(r.sectionTypes.some((t) => t.type === 'hero' && t.fields.includes('headline')), 'lists section types with their fields');

  console.log('\n[3] create_website is confirmation-gated, then builds a multi-page site');
  r = await executeIvyTool('create_website', { template_pack: 'creative_studio', business_name: `Market Theory ${S}` }, ctx);
  assert(r.needs_confirmation === true && /template/i.test(r.summary || ''), `asks for approval first (${(r.summary || '').slice(0, 70)}…)`);
  r = await runApprovedTool('create_website', { template_pack: 'creative_studio', business_name: `Market Theory ${S}` }, ctx);
  assert(r.ok === true && r.website.pages.length === 3, `built 3 pages (got ${r.website?.pages?.length})`);
  assert(r.website.handle === `market-theory-${S}`, `handle derived from the name (${r.website.handle})`);
  assert(r.website.launched === false, 'not public yet');
  const home = r.website.pages.find((p) => p.slug === '');
  const heroId = home.sections.find((s) => s.type === 'hero').id;
  assert(!!heroId, 'home page has a hero with an id');

  // A draft edit waits for Approve (nothing saved before), then runs.
  const gated = async (name, args) => {
    const before = JSON.stringify((await sql`SELECT pages FROM websites WHERE workspace_id = ${a.workspaceId}`).rows[0].pages);
    const held = await executeIvyTool(name, args, ctx);
    if (held.error) return held;
    const after = JSON.stringify((await sql`SELECT pages FROM websites WHERE workspace_id = ${a.workspaceId}`).rows[0].pages);
    assert(held.needs_confirmation === true && before === after, `${name} ${args.action || ''}: held for approval, draft unchanged`);
    return runApprovedTool(name, args, ctx);
  };
  console.log('\n[4] edit the draft: copy, add a section, hide one, add a page');
  r = await gated('edit_website_section', { page_slug: '', action: 'update', section_id: heroId, data: { headline: 'Portraits with soul.', sub: 'Austin, TX', bogus: 'ignored' } });
  const hero = r.pages.find((p) => p.slug === '').sections.find((s) => s.id === heroId);
  assert(hero.headline === 'Portraits with soul.' && hero.sub === 'Austin, TX', 'hero copy updated');
  const saved = (await sql`SELECT pages FROM websites WHERE workspace_id = ${a.workspaceId}`).rows[0].pages;
  const savedHero = saved.find((p) => p.slug === '').sections.find((s) => s.id === heroId);
  assert(!('bogus' in savedHero.data), 'unknown fields are dropped');
  // 1.0.7: website copy is plain words. Formatting marks Ivy might write
  // are stored as the words they stand for, never as symbols on the site.
  await gated('edit_website_section', { page_slug: '', action: 'update', section_id: heroId, data: { headline: '**Portraits** with soul.', sub: 'Austin, TX<br>By [appointment](https://example.com)' } });
  const plain = (await sql`SELECT pages FROM websites WHERE workspace_id = ${a.workspaceId}`).rows[0].pages
    .find((p) => p.slug === '').sections.find((s) => s.id === heroId).data;
  assert(plain.headline === 'Portraits with soul.' && plain.sub === 'Austin, TX\nBy appointment', `formatting marks saved as plain words (${JSON.stringify([plain.headline, plain.sub])})`);
  await gated('edit_website_section', { page_slug: '', action: 'update', section_id: heroId, data: { headline: 'Portraits with soul.', sub: 'Austin, TX' } });
  r = await gated('edit_website_section', { page_slug: '', action: 'add', type: 'faq', position: 1, data: { headline: 'Questions?' } });
  const homeSecs = () => r.pages.find((p) => p.slug === '').sections;
  assert(r.added.type === 'faq' && homeSecs()[1].type === 'faq', 'FAQ added at position 1');
  const logos = homeSecs().find((s) => s.type === 'logos');
  r = await gated('edit_website_section', { page_slug: '', action: 'hide', section_id: logos.id });
  assert(homeSecs().find((s) => s.id === logos.id).visible === false, 'logos hidden');
  r = await gated('edit_website_page', { action: 'add', slug: 'pricing', title: 'Pricing', section_types: ['hero', 'pricing', 'footer'] });
  assert(r.ok && r.page.sections.map((s) => s.type).join(',') === 'hero,pricing,footer', 'pricing page added with its sections');
  r = await gated('edit_website_page', { action: 'remove', slug: '' });
  assert(/home page cannot/i.test(r.error || ''), 'home page cannot be removed (refused before any card)');
  r = await gated('update_website', { seo_title: 'Market Theory · Portrait photography' });
  assert(r.ok && r.website.pages.length === 4, 'site-level update keeps the 4 pages');

  console.log('\n[5] publish is gated, then goes live');
  r = await executeIvyTool('publish_website', {}, ctx);
  assert(r.needs_confirmation === true, 'publish asks for approval');
  r = await runApprovedTool('publish_website', {}, ctx);
  assert(r.ok === true && /\/site\/market-theory-/.test(r.url || ''), `live URL returned (${r.url})`);
  const row = (await sql`SELECT launched, published_pages FROM websites WHERE workspace_id = ${a.workspaceId}`).rows[0];
  assert(row.launched === true && row.published_pages.length === 4, 'launched with the 4 pages published');

  console.log('\n[6] another workspace sees nothing of it');
  r = await executeIvyTool('get_website', {}, { workspaceId: b.workspaceId });
  assert(r.website.exists === false, 'other workspace has no site');
  r = await executeIvyTool('edit_website_section', { page_slug: '', action: 'update', section_id: heroId, data: { headline: 'hacked' } }, { workspaceId: b.workspaceId });
  assert(!!r.error, 'cannot edit a section it does not own');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
run().catch((e) => { console.error('crashed:', e); process.exit(1); });
