// Ivy builds, edits and publishes the owner's website.
// Run: node --import ./tests/bootstrap.mjs ./tests/ivy-website-tools.test.mjs
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { executeIvyTool, IVY_TOOLS, SENSITIVE_TOOLS } from '../api/_lib/ivyTools.js';

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
  assert(SENSITIVE_TOOLS.has('create_website') && SENSITIVE_TOOLS.has('publish_website') && !SENSITIVE_TOOLS.has('edit_website_section'), 'build + publish need approval; draft edits do not');

  console.log('\n[2] get_website on a fresh workspace');
  let r = await executeIvyTool('get_website', {}, ctx);
  assert(r.website && r.website.exists === false, 'reports no site yet');
  assert(Array.isArray(r.templatePacks) && r.templatePacks.some((p) => p.id === 'creative_studio'), 'lists template packs');
  assert(r.sectionTypes.some((t) => t.type === 'hero' && t.fields.includes('headline')), 'lists section types with their fields');

  console.log('\n[3] create_website is confirmation-gated, then builds a multi-page site');
  r = await executeIvyTool('create_website', { template_pack: 'creative_studio', business_name: `Market Theory ${S}` }, ctx);
  assert(r.needs_confirmation === true && /template/i.test(r.summary || ''), `asks for approval first (${(r.summary || '').slice(0, 70)}…)`);
  r = await executeIvyTool('create_website', { template_pack: 'creative_studio', business_name: `Market Theory ${S}`, confirm: true }, ctx);
  assert(r.ok === true && r.website.pages.length === 3, `built 3 pages (got ${r.website?.pages?.length})`);
  assert(r.website.handle === `market-theory-${S}`, `handle derived from the name (${r.website.handle})`);
  assert(r.website.launched === false, 'not public yet');
  const home = r.website.pages.find((p) => p.slug === '');
  const heroId = home.sections.find((s) => s.type === 'hero').id;
  assert(!!heroId, 'home page has a hero with an id');

  console.log('\n[4] edit the draft: copy, add a section, hide one, add a page');
  r = await executeIvyTool('edit_website_section', { page_slug: '', action: 'update', section_id: heroId, data: { headline: 'Portraits with soul.', sub: 'Austin, TX', bogus: 'ignored' } }, ctx);
  const hero = r.sections.find((s) => s.id === heroId);
  assert(hero.headline === 'Portraits with soul.' && hero.sub === 'Austin, TX', 'hero copy updated');
  const saved = (await sql`SELECT pages FROM websites WHERE workspace_id = ${a.workspaceId}`).rows[0].pages;
  const savedHero = saved.find((p) => p.slug === '').sections.find((s) => s.id === heroId);
  assert(!('bogus' in savedHero.data), 'unknown fields are dropped');
  r = await executeIvyTool('edit_website_section', { page_slug: '', action: 'add', type: 'faq', position: 1, data: { headline: 'Questions?' } }, ctx);
  assert(r.added.type === 'faq' && r.sections[1].type === 'faq', 'FAQ added at position 1');
  const logos = r.sections.find((s) => s.type === 'logos');
  r = await executeIvyTool('edit_website_section', { page_slug: '', action: 'hide', section_id: logos.id }, ctx);
  assert(r.sections.find((s) => s.id === logos.id).visible === false, 'logos hidden');
  r = await executeIvyTool('edit_website_page', { action: 'add', slug: 'pricing', title: 'Pricing', section_types: ['hero', 'pricing', 'footer'] }, ctx);
  assert(r.ok && r.page.sections.map((s) => s.type).join(',') === 'hero,pricing,footer', 'pricing page added with its sections');
  r = await executeIvyTool('edit_website_page', { action: 'remove', slug: '' }, ctx);
  assert(/home page cannot/i.test(r.error || ''), 'home page cannot be removed');
  r = await executeIvyTool('update_website', { seo_title: 'Market Theory · Portrait photography' }, ctx);
  assert(r.ok && r.website.pages.length === 4, 'site-level update keeps the 4 pages');

  console.log('\n[5] publish is gated, then goes live');
  r = await executeIvyTool('publish_website', {}, ctx);
  assert(r.needs_confirmation === true, 'publish asks for approval');
  r = await executeIvyTool('publish_website', { confirm: true }, ctx);
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
