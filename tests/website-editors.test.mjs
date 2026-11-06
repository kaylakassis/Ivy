// Website builder: no owner ever sees or types code.
//   - every section type has a plain-language editor (set equality with
//     sections.js, so a new type cannot ship without one)
//   - the section library and Ivy's catalog exclude the legacy code types
//   - an existing code section still renders and saves, but the server
//     and Ivy refuse NEW ones
//   - the server HTML renderer renders every type from its default data
//   - Ivy can change one list entry ("step 2") and validates per type
// Run: node --import ./tests/bootstrap.mjs ./tests/website-editors.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';


import esbuild from 'esbuild';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import websiteHandler from '../api/website/index.js';
import { renderSiteHtml } from '../api/_lib/siteHtml.js';
import { executeIvyTool, runApprovedTool } from '../api/_lib/ivyTools.js';
import { SECTION_TYPES, LIBRARY_SECTIONS, LEGACY_CODE_TYPES, mkSection } from '../src/features/website/sections.js';
import { videoEmbedUrl } from '../src/lib/videoEmbed.js';
import { hoursText, parseHoursText, normalizeDay } from '../src/features/website/hoursText.js';
import { normalizeInstagram, normalizeSocialUrl } from '../src/features/website/socialLinks.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
const S = Date.now();
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

// The editors are JSX; bundle them once (React included, so the editors'
// hooks and the renderer share one React) and import the result.
async function loadEditors() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ivy-editors-'));
  const out = path.join(dir, 'editors.mjs');
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'tests/fixtures/website-editors-entry.jsx')],
    bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent',
    define: { 'import.meta.env.VITE_API_BASE_URL': '""', 'import.meta.env.DEV': 'false', 'import.meta.env': '{}' },
    // The upload client drags in a node HTTP stack; the editors only call it on a click.
    alias: { '@vercel/blob/client': path.join(ROOT, 'tests/fixtures/stubs/vercel-blob-client.js') },
    jsx: 'automatic',
    // react-dom/server is CommonJS and asks for node builtins at run time.
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  });
  return import(pathToFileURL(out).href);
}

// Words an owner must never read in the builder (checked as whole words so
// "description" does not trip "script").
const JARGON = /\b(json|html|css|url|urls|slug|slugs|embed|embeds|snippet|snippets|metadata|hex|markdown|script|webhook|iframe|src|href)\b/i;

async function owner(tag) {
  const u = await sql`INSERT INTO users (email, password_hash, name, email_verified_at, terms_version, terms_accepted_at) VALUES (${`wbed-${tag}-${S}@example.com`}, 'x', 'Owner', NOW(), '2026-05-05', NOW()) RETURNING id`;
  const w = await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, onboarded_at) VALUES (${u.rows[0].id}, 'WS', 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`;
  return { userId: u.rows[0].id, workspaceId: w.rows[0].id };
}
function mockRes() {
  return { statusCode: 200, body: null, headers: {},
    status(c) { this.statusCode = c; return this; }, setHeader(k, v) { this.headers[k] = v; },
    json(o) { this.body = o; return this; }, end() { return this; } };
}
const putReq = (uid, body) => ({
  method: 'PUT', url: '/api/website', query: {}, body, on() {},
  headers: { host: 'localhost:3001', origin: 'http://localhost:3001', 'content-type': 'application/json', cookie: `ivy_session=${signSession(uid)}` },
});

async function run() {
  await ensureSchemaApplied();
  const E = await loadEditors();
  const { React, renderToStaticMarkup } = E;
  const allTypes = Object.keys(SECTION_TYPES);
  const editable = allTypes.filter((t) => !LEGACY_CODE_TYPES.has(t));

  console.log('\n[1] every section type has an editor; the library hides code types');
  const editorKeys = Object.keys(E.EDITORS).sort();
  assert(JSON.stringify(editorKeys) === JSON.stringify([...editable].sort()), `EDITORS covers exactly the ${editable.length} non-code types (missing: ${editable.filter((t) => !E.EDITORS[t]).join(', ') || 'none'}; extra: ${editorKeys.filter((t) => !editable.includes(t)).join(', ') || 'none'})`);
  assert(E.EDITOR_COVERAGE.length === 0, 'EDITOR_COVERAGE guard is empty');
  assert(LIBRARY_SECTIONS.length === editable.length && !LIBRARY_SECTIONS.some((s) => LEGACY_CODE_TYPES.has(s.type)), 'section library offers every type except custom_html and code_snippet');
  assert(LEGACY_CODE_TYPES.has('custom_html') && LEGACY_CODE_TYPES.has('code_snippet') && SECTION_TYPES.custom_html && SECTION_TYPES.code_snippet, 'code types still exist (existing sites keep rendering) but are flagged legacy');
  assert(!LIBRARY_SECTIONS.some((s) => JARGON.test(`${s.label} ${s.desc}`)), 'library tile names and descriptions use no code words');

  console.log('\n[2] each editor renders from the default data, in plain language, with no raw data');
  const pages = [{ id: 'home', slug: '', title: 'Home', sections: [] }, { id: 'about', slug: 'about', title: 'About', sections: [] }];
  for (const type of editable) {
    const sec = mkSection(type, 'Glow Studio');
    let html = '';
    let threw = null;
    try {
      html = renderToStaticMarkup(React.createElement(E.Inspector, {
        section: sec, onChange() {}, onMoveUp() {}, onMoveDown() {}, onDelete() {}, onToggleVisible() {},
        pages, sections: [sec], mobile: false,
      }));
    } catch (e) { threw = e; }
    const dump = /\{&quot;|\{"|\[object Object\]/.test(html);
    assert(!threw && html.length > 200 && !dump && !JARGON.test(html.replace(/<[^>]+>/g, ' ')), `${type}: renders${threw ? ` (threw: ${threw.message})` : dump ? ' (shows raw data!)' : JARGON.test(html.replace(/<[^>]+>/g, ' ')) ? ` (jargon: ${(html.replace(/<[^>]+>/g, ' ').match(JARGON) || [])[0]})` : ''}`);
  }
  {
    // Phone: same editors at 390px are the mobile sheet; render once with mobile=true.
    const sec = mkSection('process', 'Glow Studio');
    const html = renderToStaticMarkup(React.createElement(E.Inspector, { section: sec, onChange() {}, onMoveUp() {}, onMoveDown() {}, onDelete() {}, onToggleVisible() {}, pages, sections: [sec], mobile: true }));
    assert(/Step 1: Discovery call/.test(html) && /Add a step/.test(html) && /Copy to page/.test(html) === false || /Add a step/.test(html), 'process editor on a phone lists the steps with Add a step');
    assert((html.match(/aria-label="Move Step [^"]* up"/g) || []).length === 3, 'each step has up / down / remove controls');
  }

  console.log('\n[3] legacy code sections get the plain panel; unknown types get "no settings"');
  for (const type of ['custom_html', 'code_snippet']) {
    const sec = { id: 'legacy1', type, visible: true, data: type === 'custom_html' ? { html: '<script>alert(1)</script><b>hi</b>', height: 200 } : { code: 'const x = 1;', language: 'js' } };
    const html = renderToStaticMarkup(React.createElement(E.Inspector, { section: sec, onChange() {}, onMoveUp() {}, onMoveDown() {}, onDelete() {}, onToggleVisible() {}, onDuplicate() {}, onCopyToPage() {}, onOpenLibrary() {}, pages, sections: [sec] }));
    assert(/This section was added with code\. Ivy no longer uses code sections\. You can remove it, or replace it with a section from the library\./.test(html), `${type}: plain-language panel`);
    assert(/>\s*Remove\s*</.test(html.replace(/<svg[\s\S]*?<\/svg>/g, '')) && /Open section library/.test(html), `${type}: Remove and Open section library buttons`);
    assert(!/alert\(1\)|const x = 1|Layout|Section style|Duplicate section|Copy to page/.test(html), `${type}: no code shown, no style or copy controls`);
  }
  {
    const html = renderToStaticMarkup(React.createElement(E.Inspector, { section: { id: 'x', type: 'unicorn', visible: true, data: { secret: 'json-ish' } }, onChange() {}, onMoveUp() {}, onMoveDown() {}, onDelete() {}, onToggleVisible() {}, pages, sections: [] }));
    assert(/This section has no settings\./.test(html) && !/json-ish/.test(html), 'unknown type: "This section has no settings." and no data dump');
  }
  {
    const html = renderToStaticMarkup(React.createElement(E.Inspector, { section: null, currentPage: { id: 'home', slug: '', title: 'Home' }, onPageChange() {}, onChange() {}, pages, sections: [] }));
    assert(/Page title shown in Google/.test(html) && /Short description shown in Google/.test(html) && !/\bSEO\b|\bmeta\b/i.test(html), 'page search settings use plain labels');
  }

  console.log('\n[4] helpers: video links, hours text, social links');
  assert(videoEmbedUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=4s') === 'https://www.youtube.com/embed/dQw4w9WgXcQ', 'YouTube watch link converts');
  assert(videoEmbedUrl('https://youtu.be/dQw4w9WgXcQ') === 'https://www.youtube.com/embed/dQw4w9WgXcQ', 'youtu.be short link converts');
  assert(videoEmbedUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ') === 'https://www.youtube.com/embed/dQw4w9WgXcQ', 'YouTube shorts link converts');
  assert(videoEmbedUrl('https://vimeo.com/123456789') === 'https://player.vimeo.com/video/123456789', 'Vimeo link converts');
  assert(videoEmbedUrl('https://www.loom.com/share/abcDEF1234567890') === 'https://www.loom.com/embed/abcDEF1234567890', 'Loom share link converts');
  assert(videoEmbedUrl('youtube.com/watch?v=dQw4w9WgXcQ') === 'https://www.youtube.com/embed/dQw4w9WgXcQ', 'a link without https still works');
  for (const bad of ['https://evil.example/embed/x', 'javascript:alert(1)', 'https://www.youtube.com/', 'https://vimeo.com/about', 'data:text/html,hi', 'not a link', '']) {
    assert(videoEmbedUrl(bad) === null, `rejected: ${JSON.stringify(bad)}`);
  }
  assert(hoursText({ open: '09:00', close: '17:30' }) === '9:00 AM to 5:30 PM', 'hours text reads naturally');
  assert(hoursText({ closed: true, open: '09:00' }) === 'Closed', 'closed day');
  assert(JSON.stringify(parseHoursText('9 – 5')) === JSON.stringify({ open: '09:00', close: '17:00', closed: false }), 'legacy "9 – 5" parses');
  assert(JSON.stringify(parseHoursText('10am-6:30pm')) === JSON.stringify({ open: '10:00', close: '18:30', closed: false }), '"10am-6:30pm" parses');
  assert(parseHoursText('Closed').closed === true, '"Closed" parses');
  assert(normalizeDay({ label: 'Mon', hours: '9 – 5' }).hours === '9:00 AM to 5:00 PM', 'legacy day is upgraded with a readable sentence');
  assert(normalizeInstagram('@glow.studio') === 'https://www.instagram.com/glow.studio/', 'Instagram username becomes a profile link');
  assert(normalizeInstagram('https://www.instagram.com/p/abc123/') === 'https://www.instagram.com/p/abc123/', 'post link kept');
  assert(normalizeSocialUrl('tiktok', 'glowstudio') === 'https://www.tiktok.com/@glowstudio', 'TikTok username becomes a profile link');

  console.log('\n[5] server HTML renders every type from default data (and legacy ones as before)');
  {
    const sections = allTypes.map((t) => {
      const s = mkSection(t, 'Glow Studio');
      if (t === 'custom_html') s.data = { html: '<b>legacy</b>', height: 120 };
      if (t === 'video') s.data.videoUrl = 'https://youtu.be/dQw4w9WgXcQ';
      if (t === 'team') s.data.members[0].link = 'https://example.com/sam';
      if (t === 'logos') { s.data.logos[0].link = 'javascript:alert(1)'; s.data.logos[1].link = 'https://nyt.example'; }
      return s;
    });
    let html = ''; let threw = null;
    try {
      html = renderSiteHtml({ site: { template: 'clean', businessName: 'Glow Studio' }, page: { title: 'Home', sections }, nav: [], handle: 'glow', currentSlug: '', host: 'joinivy.ai' });
    } catch (e) { threw = e; }
    assert(!threw, `renders all ${allTypes.length} types without throwing${threw ? ` (${threw.message})` : ''}`);
    assert(/ivy-custom-html/.test(html) && /sandbox=""/.test(html) && /&lt;b&gt;legacy/.test(html) === false && /<b>legacy<\/b>/.test(html), 'existing custom code still renders in its sandboxed frame exactly as before');
    assert(/ivy-process/.test(html) && /Discovery call/.test(html), 'process section renders its steps');
    assert(/href="https:\/\/example.com\/sam"/.test(html), 'team member link renders');
    assert(/href="https:\/\/nyt.example"/.test(html) && !/javascript:/.test(html), 'logo links render, unsafe ones neutralised');
    assert(/9:00 AM to 5:00 PM/.test(html), 'hours render the readable text');
  }

  console.log('\n[6] PUT /api/website refuses NEW code sections, keeps existing ones');
  const A = await owner('a');
  const legacy = { id: 'legacy1', type: 'custom_html', visible: true, data: { html: '<b>old</b>', height: 120 } };
  const basePages = () => [{ id: 'home', slug: '', title: 'Home', inNav: true, sections: [mkSection('hero', 'A'), legacy] }];
  await sql`INSERT INTO websites (workspace_id, handle, business_name, pages, sections) VALUES (${A.workspaceId}, ${`wbed-${S}`}, 'A', ${JSON.stringify(basePages())}::jsonb, ${JSON.stringify(basePages()[0].sections)}::jsonb)`;
  {
    let res = mockRes();
    const kept = basePages(); kept[0].sections[0].data.headline = 'Changed';
    await websiteHandler(putReq(A.userId, { pages: kept }), res);
    assert(res.statusCode === 200 && res.body?.website, `saving a site that already has a code section works (${res.statusCode})`);
    const saved = (await sql`SELECT pages FROM websites WHERE workspace_id = ${A.workspaceId}`).rows[0].pages;
    assert(saved[0].sections.some((s) => s.id === 'legacy1' && s.data.html === '<b>old</b>') && saved[0].sections[0].data.headline === 'Changed', 'existing code section saved unchanged alongside the edit');

    res = mockRes();
    const withNew = basePages(); withNew[0].sections.push({ id: 'brandnew', type: 'custom_html', visible: true, data: { html: '<script>x</script>' } });
    await websiteHandler(putReq(A.userId, { pages: withNew }), res);
    assert(res.statusCode === 400 && /Code sections can no longer be added/.test(res.body?.error || JSON.stringify(res.body)), `a new custom_html section is refused (${res.statusCode}: ${res.body?.error})`);

    res = mockRes();
    const withSnippet = basePages(); withSnippet[0].sections.push({ id: 'snip1', type: 'code_snippet', visible: true, data: { code: 'x', language: 'js' } });
    await websiteHandler(putReq(A.userId, { pages: withSnippet }), res);
    assert(res.statusCode === 400, 'a new code_snippet section is refused');

    res = mockRes();
    await websiteHandler(putReq(A.userId, { sections: [mkSection('hero', 'A'), { ...legacy, id: 'legacy-new' }] }), res);
    assert(res.statusCode === 400, 'legacy sections list: a code section under a new id is refused');

    res = mockRes();
    await websiteHandler(putReq(A.userId, { scheduledPublishAt: new Date(Date.now() + 3600_000).toISOString(), scheduledPages: withNew }), res);
    assert(res.statusCode === 400, 'a scheduled copy cannot smuggle a new code section in');

    res = mockRes();
    const normal = basePages(); normal[0].sections.push(mkSection('process', 'A'));
    await websiteHandler(putReq(A.userId, { pages: normal }), res);
    assert(res.statusCode === 200, 'adding a normal section still saves');
    const after = (await sql`SELECT pages FROM websites WHERE workspace_id = ${A.workspaceId}`).rows[0].pages;
    assert(after[0].sections.filter((s) => s.type === 'custom_html').length === 1, 'exactly the one legacy code section remains');
  }

  console.log('\n[7] Ivy: refuses code sections, edits the new types field by field, changes "step 2"');
  const ctx = { workspaceId: A.workspaceId, userId: A.userId };
  {
    let r = await executeIvyTool('get_website', {}, ctx);
    assert(!r.sectionTypes.some((t) => LEGACY_CODE_TYPES.has(t.type)) && r.sectionTypes.length === editable.length, 'Ivy catalog lists every editable type and no code type');
    const proc = r.sectionTypes.find((t) => t.type === 'process');
    assert(proc && proc.lists && JSON.stringify(proc.lists.steps) === JSON.stringify(['number', 'title', 'desc']), `catalog tells Ivy the fields of a step (${JSON.stringify(proc?.lists)})`);
    const home = r.website.pages.find((p) => p.slug === '');
    const procSec = home.sections.find((s) => s.type === 'process');
    assert(procSec.lists && procSec.lists.steps[1].n === 2 && procSec.lists.steps[1].title === 'Plan + proposal', 'get_website shows the numbered steps so "step 2" is unambiguous');
    const legacySummary = home.sections.find((s) => s.type === 'custom_html');
    assert(legacySummary.legacyCode === true && !('lists' in legacySummary) && !JSON.stringify(legacySummary).includes('<b>old</b>'), 'legacy section is marked and its code is not echoed to Ivy');

    r = await executeIvyTool('edit_website_section', { action: 'add', page_slug: '', type: 'custom_html' }, ctx);
    assert(/no longer uses code sections/.test(r.error || '') && /Nothing was changed/.test(r.error || ''), `add custom_html refused: ${r.error}`);
    r = await executeIvyTool('edit_website_section', { action: 'add', page_slug: '', type: 'code_snippet' }, ctx);
    assert(/no longer uses code sections/.test(r.error || ''), 'add code_snippet refused');
    r = await executeIvyTool('edit_website_page', { action: 'add', slug: 'extra', title: 'Extra', section_types: ['hero', 'custom_html'] }, ctx);
    assert(/no longer uses code sections/.test(r.error || ''), 'new page with a code section refused');
    r = await executeIvyTool('edit_website_section', { action: 'update', section_id: 'legacy1', data: { html: '<b>new</b>' } }, ctx);
    assert(/added with code/.test(r.error || '') && /not edited/.test(r.error || ''), `editing the legacy section refused: ${r.error}`);
    r = await executeIvyTool('edit_website_section', { action: 'duplicate', section_id: 'legacy1' }, ctx);
    assert(/added with code/.test(r.error || ''), 'duplicating the legacy section refused');
    r = await executeIvyTool('edit_website_section', { action: 'hide', section_id: 'legacy1' }, ctx);
    assert(r.needs_confirmation === true && /Hide the 'Custom code'/.test(r.summary || ''), `hiding it is allowed (card: ${r.summary})`);

    // "Change step 2 of how it works to ..."
    r = await executeIvyTool('edit_website_section', { action: 'update', section_id: procSec.id, item_number: 2, item: { title: 'Your plan', desc: 'A written plan within two days.' } }, ctx);
    assert(r.needs_confirmation === true && /step 2: title to "Your plan"/.test(r.summary || ''), `card words the step change (${r.summary})`);
    r = await runApprovedTool('edit_website_section', { action: 'update', section_id: procSec.id, item_number: 2, item: { title: 'Your plan', desc: 'A written plan within two days.' } }, ctx);
    const steps = r.pages.find((p) => p.slug === '').sections.find((s) => s.id === procSec.id).lists.steps;
    assert(steps[1].title === 'Your plan' && steps[1].number === '02' && steps[0].title === 'Discovery call' && steps.length === 3, 'step 2 changed, the others untouched, numbering kept');
    r = await runApprovedTool('edit_website_section', { action: 'update', section_id: procSec.id, item: { title: 'Follow-up', desc: 'A check-in a month later.' } }, ctx);
    const steps2 = r.pages.find((p) => p.slug === '').sections.find((s) => s.id === procSec.id).lists.steps;
    assert(steps2.length === 4 && steps2[3].number === '04' && steps2[3].title === 'Follow-up', 'a new step is added at the end and auto-numbered 04');
    r = await runApprovedTool('edit_website_section', { action: 'update', section_id: procSec.id, item_number: 1, remove_item: true }, ctx);
    const steps3 = r.pages.find((p) => p.slug === '').sections.find((s) => s.id === procSec.id).lists.steps;
    assert(steps3.length === 3 && steps3[0].title === 'Your plan' && steps3[0].number === '01', 'removing step 1 renumbers the rest');
    r = await executeIvyTool('edit_website_section', { action: 'update', section_id: procSec.id, item_number: 9, item: { title: 'x' } }, ctx);
    assert(/item_number must be between 1 and 3/.test(r.error || ''), 'out-of-range step refused plainly');
    r = await executeIvyTool('edit_website_section', { action: 'update', section_id: procSec.id, item_number: 1, item: { bogus: 'x' } }, ctx);
    assert(/Fields: number, title, desc/.test(r.error || ''), `unknown step field refused with the field list (${r.error})`);

    // Per-type validation for the newly editable types.
    r = await runApprovedTool('edit_website_section', { action: 'add', page_slug: '', type: 'video', data: { headline: 'Watch', videoUrl: 'https://youtu.be/dQw4w9WgXcQ' } }, ctx);
    assert(r.ok && r.added.type === 'video', 'video with a YouTube link added');
    r = await executeIvyTool('edit_website_section', { action: 'update', section_id: r.added.id, data: { videoUrl: 'https://evil.example/thing' } }, ctx);
    assert(/not a YouTube, Vimeo or Loom link/.test(r.error || ''), `other video hosts refused: ${r.error}`);
    r = await runApprovedTool('edit_website_section', { action: 'add', page_slug: '', type: 'hours', data: { days: [{ label: 'Monday', open: '08:00', close: '16:00' }, { label: 'Sunday', closed: true }] } }, ctx);
    const days = r.added.lists.days;
    assert(days[0].hours === '8:00 AM to 4:00 PM' && days[1].hours === 'Closed', 'hours from Ivy get the readable text visitors see');
    r = await executeIvyTool('edit_website_section', { action: 'add', page_slug: '', type: 'social_feed', data: { platform: 'myspace', url: 'x' } }, ctx);
    assert(/platform must be one of/.test(r.error || ''), 'unknown social network refused');
    r = await runApprovedTool('edit_website_section', { action: 'add', page_slug: '', type: 'social_feed', data: { platform: 'tiktok', url: '@glow' } }, ctx);
    assert(r.added.url === 'https://www.tiktok.com/@glow', 'a TikTok username becomes the profile link');
    r = await runApprovedTool('edit_website_section', { action: 'add', page_slug: '', type: 'instagram', data: { url: '@glow.studio' } }, ctx);
    assert(r.added.url === 'https://www.instagram.com/glow.studio/', 'an Instagram username becomes the profile link');
    r = await runApprovedTool('edit_website_section', { action: 'add', page_slug: '', type: 'pricing', data: { tiers: [{ name: 'Solo', price: '$50', features: ['One session'], featured: true, ctaText: 'Go', nonsense: 1 }] } }, ctx);
    const tier = r.added.lists.tiers[0];
    assert(tier.name === 'Solo' && tier.featured === true && !('nonsense' in tier) && Array.isArray(tier.features), 'pricing plan entries keep known fields only');
    r = await runApprovedTool('edit_website_section', { action: 'add', page_slug: '', type: 'pricing_table', data: { tiers: ['A', 'B'], rows: [{ label: 'Sessions', values: ['1', '3'] }] } }, ctx);
    assert(r.added.lists.tiers[0].value === 'A' && r.added.lists.rows[0].label === 'Sessions', 'pricing table columns and rows set');
    r = await executeIvyTool('edit_website_section', { action: 'update', section_id: r.added.id, item_number: 1, item: { label: 'x' } }, ctx);
    assert(/Say which list with list_field: tiers, rows/.test(r.error || ''), 'two lists: Ivy is asked which one');
    r = await executeIvyTool('edit_website_section', { action: 'add', page_slug: '', type: 'countdown', data: { endDate: 'someday' } }, ctx);
    assert(/endDate must be a date and time/.test(r.error || ''), 'bad countdown date refused');
    r = await runApprovedTool('edit_website_section', { action: 'add', page_slug: '', type: 'map', data: { address: '1600 Pennsylvania Ave NW, Washington, DC', showMap: true } }, ctx);
    assert(r.ok && r.added.address && !('__geocode' in r.added), 'map section saved from an address (pin looked up when possible, never required)');
    const saved = (await sql`SELECT pages FROM websites WHERE workspace_id = ${A.workspaceId}`).rows[0].pages;
    assert(!JSON.stringify(saved).includes('__geocode'), 'no lookup marker is stored');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  await sql`DELETE FROM websites WHERE workspace_id = ${A.workspaceId}`;
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
