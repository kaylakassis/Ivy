// Ivy can change how a website section looks, exactly like the editor's
// "Section style" panel, and nothing more.
//   [1] plain-language requests map to the editor's own stored values,
//       held for approval (nothing written), card in words with a chip
//   [2] every option: swatches, custom colour, spacing, alignment, devices,
//       headline effect, parallax, animation + timings, stop the animation
//   [3] junk and CSS injection are refused before any card is shown
//   [4] get_website reports each section's look in plain words
//   [5] another workspace can neither see nor change it
//   [6] the server HTML applies the style and ignores unsafe stored values
//   [7] the React renderer does the same; the card's chips paint only safe colours
//
// Run: node --import ./tests/bootstrap.mjs ./tests/ivy-website-style.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { executeIvyTool, runApprovedTool, ledgerEntry } from '../api/_lib/ivyTools.js';
import { renderSiteHtml } from '../api/_lib/siteHtml.js';
import { safeBackground, safeHeadlineGradient, describeSectionStyle, colorWords } from '../src/features/website/sectionStyle.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
const S = Date.now();
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

async function owner(tag) {
  const u = await sql`INSERT INTO users (email, password_hash, name, email_verified_at) VALUES (${`ivystyle-${tag}-${S}@example.com`}, 'x', 'Owner', NOW()) RETURNING id`;
  const w = await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, onboarded_at) VALUES (${u.rows[0].id}, 'WS', 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`;
  return { userId: u.rows[0].id, workspaceId: w.rows[0].id };
}

const startPages = () => ([
  { id: 'home', slug: '', title: 'Home', inNav: true, sections: [
    { id: 'hero', type: 'hero', visible: true, animate: 'rise', data: { headline: 'Hi there' } },
    { id: 'ab', type: 'about', visible: true, style: {}, data: { headline: 'About me' } },
    { id: 'gal', type: 'gallery', visible: true, data: { title: 'Work', images: [] } },
    { id: 'price', type: 'pricing', visible: true, data: { headline: 'Prices' } },
  ] },
]);
const draft = async (ws) => (await sql`SELECT pages FROM websites WHERE workspace_id = ${ws}`).rows[0].pages;
const sec = (pages, id) => pages[0].sections.find((s) => s.id === id);

async function loadBundle() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ivy-style-'));
  const out = path.join(dir, 'bundle.mjs');
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'tests/fixtures/section-style-entry.jsx')],
    bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent',
    define: { 'import.meta.env.VITE_API_BASE_URL': '""', 'import.meta.env.DEV': 'false', 'import.meta.env': '{}' },
    alias: { '@vercel/blob/client': path.join(ROOT, 'tests/fixtures/stubs/vercel-blob-client.js') },
    jsx: 'automatic',
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  });
  return import(pathToFileURL(out).href);
}

async function run() {
  await ensureSchemaApplied();
  const A = await owner('a');
  const B = await owner('b');
  const ctx = { workspaceId: A.workspaceId, userId: A.userId, sessionId: null };
  const ctxB = { workspaceId: B.workspaceId, userId: B.userId, sessionId: null };
  await sql`INSERT INTO websites (workspace_id, handle, business_name, pages, sections)
            VALUES (${A.workspaceId}, ${`style-${S}`}, 'Style Studio', ${JSON.stringify(startPages())}::jsonb, ${JSON.stringify(startPages()[0].sections)}::jsonb)`;

  async function gated(args, label) {
    const before = JSON.stringify(await draft(A.workspaceId));
    const held = await executeIvyTool('edit_website_section', args, ctx);
    const after = JSON.stringify(await draft(A.workspaceId));
    assert(held.needs_confirmation === true && before === after, `${label}: held for approval, nothing written`);
    const done = await runApprovedTool('edit_website_section', args, ctx);
    assert(done.ok === true, `${label}: ran after approval`);
    return { held, done, pages: await draft(A.workspaceId) };
  }

  console.log('[1] "make the About section\'s background a soft green"');
  {
    const args = { action: 'update', section_id: 'ab', style: { background: '#A8C5A0' } };
    const { held, pages } = await gated(args, 'custom background');
    assert(held.summary === `Change how the 'About' ("About me") section on Home looks: background to a custom color (light green)`, `card: ${held.summary}`);
    assert(!/#[0-9a-f]{3,6}/i.test(held.summary), 'card shows no colour code');
    assert(Array.isArray(held.swatches) && held.swatches.length === 1 && held.swatches[0].color === '#a8c5a0' && held.swatches[0].label === 'Custom color', 'card carries a colour chip for the custom colour');
    assert(sec(pages, 'ab').style.background === '#a8c5a0', 'stored as the editor stores a picked colour (#rrggbb)');
    const [{ n }] = (await sql`SELECT COUNT(*)::int AS n FROM ivy_pending_actions WHERE workspace_id = ${A.workspaceId} AND tool = 'edit_website_section'`).rows;
    assert(n >= 1, 'recorded as a pending action (approval-gated)');
    const w = ledgerEntry('edit_website_section', args, held);
    assert(w.status === 'waiting', 'ledger: waiting until approved');

    const sw = await gated({ action: 'update', section_id: 'ab', style: { background: 'Sage green' } }, 'swatch by name');
    assert(/background to Sage green$/.test(sw.held.summary), `card: ${sw.held.summary}`);
    assert(sec(sw.pages, 'ab').style.background === '#5B7C5F', 'swatch stored with the editor\'s exact value');
    const back = await gated({ action: 'update', section_id: 'ab', style: { background: 'template' } }, 'back to template');
    assert(/background back to the template color/.test(back.held.summary), `card: ${back.held.summary}`);
    assert(!('background' in sec(back.pages, 'ab').style), 'template colour = no background key (as the editor)');
    const blend = await gated({ action: 'update', section_id: 'ab', style: { background: 'sunset_blend' } }, 'blend swatch');
    assert(sec(blend.pages, 'ab').style.background === 'linear-gradient(135deg,#E5572B,#F2D2BC)', 'blend stored as the editor\'s gradient');
    const hexSame = await executeIvyTool('edit_website_section', { action: 'update', section_id: 'ab', style: { background: '#5b7c5f' } }, ctx);
    assert(/background to Sage green/.test(hexSame.summary), 'a code that matches a swatch is named as that swatch');
  }

  console.log('[2] every option the panel offers');
  {
    let r = await gated({ action: 'update', section_id: 'price', style: { spacing: 'roomy' } }, 'more space');
    assert(/space above and below to Roomy/.test(r.held.summary), `card: ${r.held.summary}`);
    assert(sec(r.pages, 'price').style.padding === 'spacious', 'Roomy = spacious');
    r = await gated({ action: 'update', section_id: 'price', style: { spacing: 'normal', text_align: 'center' } }, 'normal + center');
    assert(!('padding' in sec(r.pages, 'price').style) && sec(r.pages, 'price').style.textAlign === 'center', 'Normal = no key; center stored');
    r = await gated({ action: 'update', section_id: 'gal', style: { show_on_phones: false } }, 'hide on phones');
    assert(/hide it on phones/.test(r.held.summary) && sec(r.pages, 'gal').style.hideOnMobile === true, 'hideOnMobile true');
    r = await gated({ action: 'update', section_id: 'gal', style: { show_on_phones: true, show_on_computers: false } }, 'swap devices');
    assert(!('hideOnMobile' in sec(r.pages, 'gal').style) && sec(r.pages, 'gal').style.hideOnDesktop === true, 'shown on phones, hidden on computers');
    r = await gated({ action: 'update', section_id: 'hero', style: { headline_effect: 'teal_to_blue', photo_moves_slower: true } }, 'headline + parallax');
    assert(sec(r.pages, 'hero').style.headlineGradient === 'linear-gradient(90deg,#2DD4BF,#3B82F6)' && sec(r.pages, 'hero').style.parallax === true, 'gradient and parallax stored');
    assert(r.held.swatches?.[0]?.label === 'Teal to blue', 'headline effect chip');
    r = await gated({ action: 'update', section_id: 'hero', style: { animation_wait_seconds: 0.5, animation_seconds: 1 } }, 'animation timing');
    assert(JSON.stringify(sec(r.pages, 'hero').animate) === JSON.stringify({ type: 'rise', delayMs: 500, durationMs: 1000 }), 'timings stored like the editor sliders');
    assert(/animation timing: waits 0.5 s, takes 1 s/.test(r.held.summary), `card: ${r.held.summary}`);
    r = await gated({ action: 'update', section_id: 'ab', style: { animation: 'fade' } }, 'add an animation');
    assert(sec(r.pages, 'ab').animate === 'fade', 'default timings stored as the plain string');
    r = await gated({ action: 'update', section_id: 'hero', style: { animation: 'none' } }, 'stop the hero animation');
    assert(sec(r.pages, 'hero').animate === null && /no animation \(it just appears\)/.test(r.held.summary), 'animation stopped');
    const same = await executeIvyTool('edit_website_section', { action: 'update', section_id: 'hero', style: { animation: 'none' } }, ctx);
    assert(same.error && /already looks like that/.test(same.error), 'no-op is refused with the current look');
    const mixed = await gated({ action: 'update', section_id: 'price', data: { headline: 'Simple prices' }, style: { spacing: 'snug' } }, 'text and look together');
    assert(/headline to "Simple prices"; and how it looks: space above and below to Snug/.test(mixed.held.summary), `card: ${mixed.held.summary}`);
    const added = await gated({ action: 'add', page_slug: '', type: 'faq', style: { background: 'warm_cream' } }, 'add with a look');
    assert(/with background to Warm cream/.test(added.held.summary), `card: ${added.held.summary}`);
    assert(added.pages[0].sections.at(-1).style.background === '#F5F1EA', 'new section has the background');
  }

  console.log('[3] junk and injection are refused before a card');
  {
    const before = JSON.stringify(await draft(A.workspaceId));
    const pendBefore = (await sql`SELECT COUNT(*)::int AS n FROM ivy_pending_actions WHERE workspace_id = ${A.workspaceId}`).rows[0].n;
    const bad = [
      [{ background: 'red;}body{display:none}' }, 'css break-out'],
      [{ background: 'url(https://evil.example/x.png)' }, 'url()'],
      [{ background: 'expression(alert(1))' }, 'expression()'],
      [{ background: 'javascript:alert(1)' }, 'javascript:'],
      [{ background: '#12345' }, 'bad hex'],
      [{ background: '#a8c5a0; color: red' }, 'hex plus extra'],
      [{ background: 'linear-gradient(90deg,#fff,url(x))' }, 'made-up gradient'],
      [{ background: 5 }, 'number'],
      [{ background: 'x'.repeat(500) }, 'too long'],
      [{ spacing: 'huge' }, 'spacing'],
      [{ text_align: 'justify' }, 'alignment'],
      [{ show_on_phones: 'yes' }, 'non-boolean'],
      [{ headline_effect: 'linear-gradient(90deg,red,blue)' }, 'raw gradient as effect'],
      [{ animation: 'spin' }, 'unknown animation'],
      [{ animation: 'fade', animation_wait_seconds: 5 }, 'wait too long'],
      [{ animation: 'fade', animation_seconds: 0.05 }, 'too fast'],
      [{ animation: 'fade', animation_seconds: 'abc' }, 'not a number'],
      [{ custom_css: 'body{}' }, 'custom css key'],
      [{ css: 'x' }, 'css key'],
      ['background: red', 'style as a string'],
    ];
    for (const [style, label] of bad) {
      const r = await executeIvyTool('edit_website_section', { action: 'update', section_id: 'ab', style }, ctx);
      assert(!r.needs_confirmation && typeof r.error === 'string', `${label}: refused (${String(r.error).slice(0, 70)})`);
    }
    const r = await executeIvyTool('edit_website_section', { action: 'update', section_id: 'ab', style: { custom_css: 'x' } }, ctx);
    assert(/Custom code or CSS is not available/.test(r.error), 'says plainly there is no custom code');
    const t = await executeIvyTool('edit_website_section', { action: 'update', section_id: 'gal', style: { animation_seconds: 1 } }, ctx);
    assert(/no animation/.test(t.error || ''), 'timing without an animation is refused');
    const legacy = (await draft(A.workspaceId));
    legacy[0].sections.push({ id: 'code1', type: 'custom_html', visible: true, data: { html: '<b>x</b>' } });
    await sql`UPDATE websites SET pages = ${JSON.stringify(legacy)}::jsonb WHERE workspace_id = ${A.workspaceId}`;
    const c = await executeIvyTool('edit_website_section', { action: 'update', section_id: 'code1', style: { background: 'white' } }, ctx);
    assert(/no longer uses code sections/.test(c.error || ''), 'a legacy code section cannot be styled');
    legacy[0].sections.pop();
    await sql`UPDATE websites SET pages = ${JSON.stringify(legacy)}::jsonb WHERE workspace_id = ${A.workspaceId}`;
    assert(JSON.stringify(await draft(A.workspaceId)) === before, 'draft unchanged by any refused call');
    const pendAfter = (await sql`SELECT COUNT(*)::int AS n FROM ivy_pending_actions WHERE workspace_id = ${A.workspaceId}`).rows[0].n;
    assert(pendAfter === pendBefore, 'no approval card recorded for a refused call');
  }

  console.log('[4] get_website reports the look in words');
  {
    await runApprovedTool('edit_website_section', { action: 'update', section_id: 'hero', style: { background: '#A8C5A0', animation: 'rise', animation_wait_seconds: 0.2 } }, ctx);
    const g = await executeIvyTool('get_website', {}, ctx);
    const hero = g.website.pages[0].sections.find((s) => s.id === 'hero');
    assert(hero.style.background === 'a custom color (light green)', `hero background: ${hero.style.background}`);
    assert(hero.style.headlineColorEffect === 'Teal to blue' && hero.style.photoMovesSlowerThanPage === 'on', 'headline effect and photo effect in words');
    assert(hero.style.appearsWhenScrolledIntoView === 'Fade up (waits 0.2 s, takes 0.7 s)', `animation: ${hero.style.appearsWhenScrolledIntoView}`);
    const gal = g.website.pages[0].sections.find((s) => s.id === 'gal');
    assert(gal.style.showsOn === 'phones only (hidden on computers)', `devices: ${gal.style.showsOn}`);
    const ab = g.website.pages[0].sections.find((s) => s.id === 'ab');
    assert(ab.style.background === 'Sunset blend' && ab.style.spaceAboveAndBelow === 'Normal', 'swatch named, default spacing');
    const price = g.website.pages[0].sections.find((s) => s.id === 'price');
    assert(price.style.spaceAboveAndBelow === 'Snug' && price.style.textAlignment === 'Center', 'spacing and alignment in words');
    assert(describeSectionStyle({ style: { background: 'url(x)' } }).background.includes('not shown'), 'an unsafe stored value is reported as not shown');
    assert(colorWords('#0D0E0C') === 'black' && colorWords('#3B82F6') === 'blue', 'colour words');
  }

  console.log('[5] another workspace');
  {
    const before = JSON.stringify(await draft(A.workspaceId));
    const r = await executeIvyTool('edit_website_section', { action: 'update', section_id: 'ab', style: { background: 'white' } }, ctxB);
    assert(!r.needs_confirmation && /No section with id/.test(r.error || ''), 'B cannot style A\'s section');
    let threw = false;
    try { await runApprovedTool('edit_website_section', { action: 'update', section_id: 'ab', style: { background: 'white' } }, ctxB); } catch { threw = true; }
    assert(JSON.stringify(await draft(A.workspaceId)) === before, `A's draft untouched (approve path ${threw ? 'threw' : 'returned an error'})`);
    const g = await executeIvyTool('get_website', {}, ctxB);
    assert(!JSON.stringify(g).includes('About me'), "B's get_website shows none of A's sections");
  }

  console.log('[6] server HTML applies the style');
  {
    const sections = (await draft(A.workspaceId))[0].sections;
    const html = renderSiteHtml({ site: { template: 'clean', businessName: 'Style Studio', handle: 's' }, page: { slug: '', title: 'Home', sections }, nav: [], handle: 's', currentSlug: '', host: 'www.joinivy.ai' });
    assert(/data-section-id="hero" style="background:#a8c5a0"/.test(html), 'hero background on the wrapper');
    assert(html.includes('[data-section-id="hero"] h1, [data-section-id="hero"] h2 { background: linear-gradient(90deg,#2DD4BF,#3B82F6)'), 'headline effect');
    assert(html.includes('[data-section-id="hero"] section { background-attachment: fixed !important; }'), 'parallax');
    assert(html.includes('@media (min-width: 721px)  { [data-section-id="gal"] { display: none !important; } }'), 'hidden on computers');
    assert(/data-section-id="price" style="padding:40px 24px;text-align:center"/.test(html), 'snug spacing and alignment');
    const evil = [
      { id: 'e1', type: 'about', visible: true, style: { background: 'red;}body{display:none}', headlineGradient: 'url(https://evil.example/a)', padding: '1px;}x{', textAlign: 'center;color:red' }, data: { headline: 'E' } },
      { id: 'e2', type: 'about', visible: true, style: { background: 'url(https://evil.example/b)' }, data: { headline: 'F' } },
    ];
    const h2 = renderSiteHtml({ site: { template: 'clean', businessName: 'X', handle: 'x' }, page: { slug: '', title: 'Home', sections: evil }, nav: [], handle: 'x', currentSlug: '', host: 'www.joinivy.ai' });
    assert(!h2.includes('evil.example') && !h2.includes('display:none}') && !h2.includes('color:red') && !h2.includes('1px;}'), 'unsafe stored values never reach the HTML');
  }

  console.log('[7] React renderer and the approval card');
  {
    const E = await loadBundle();
    const { React, renderToStaticMarkup, SectionRenderer, ColorChips } = E;
    const r = (section) => renderToStaticMarkup(React.createElement(SectionRenderer, { section, handle: 's' }));
    const html = r({ id: 'ab', type: 'about', visible: true, style: { background: '#5B7C5F', padding: 'spacious', hideOnMobile: true, headlineGradient: 'linear-gradient(90deg,#FACC15,#EAB308)' }, animate: { type: 'rise', delayMs: 500, durationMs: 1000 }, data: { headline: 'Hello' } });
    assert(/background:#5B7C5F/.test(html) && /padding:140px 80px/.test(html), 'background and Roomy spacing applied');
    assert(html.includes('@media (max-width: 720px)  { [data-section-id=&quot;ab&quot;] { display: none !important; } }') || html.includes('@media (max-width: 720px)  { [data-section-id="ab"] { display: none !important; } }'), 'hidden on phones');
    assert(html.includes('linear-gradient(90deg,#FACC15,#EAB308)'), 'headline effect');
    assert(/transition:opacity 1000ms ease 500ms/.test(html) && /translateY\(28px\)/.test(html), 'animation with its wait and duration');
    const bad = r({ id: 'x"]{}body{', type: 'about', visible: true, style: { background: 'red;}body{display:none}', headlineGradient: 'url(https://evil.example/c)' }, animate: 'spin', data: { headline: 'H' } });
    assert(!bad.includes('evil.example') && !bad.includes('display:none}') && !/transition/.test(bad), 'unsafe stored style and unknown animation ignored');
    const chips = renderToStaticMarkup(React.createElement(ColorChips, { swatches: [{ label: 'Custom color', color: '#a8c5a0' }, { label: 'Bad', color: 'url(https://evil.example/d)' }] }));
    assert(chips.includes('background:#a8c5a0') && chips.includes('Custom color') && !chips.includes('evil.example') && !chips.includes('Bad'), 'chips paint only safe colours');
    assert(safeBackground('#ABCDEF') === '#ABCDEF' && safeBackground('#abc') === '' && safeHeadlineGradient('linear-gradient(90deg,#F472B6,#A78BFA)') !== '', 'safety helpers');
    const card = renderToStaticMarkup(React.createElement(E.PendingActionCard, { actions: [{ id: '1', summary: 'Change how the About section looks: background to a custom color (light green)', swatches: [{ label: 'Custom color', color: '#a8c5a0' }] }] }));
    assert(card.includes('data-testid="color-chip"') && card.includes('light green'), 'approval card renders the summary and the chip');
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
