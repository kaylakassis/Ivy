// The /for/:slug and /vs/:slug landing pages: data wiring and copy.
//
// 1. Data: every vertical sits in exactly one directory group, every slug
//    the site links to (footer, home page persona tabs, /vs "related"
//    lists, popular list) is a real /for page, and each `use` is a list of
//    setup steps.
// 2. Copy (when a build exists, i.e. dist/prerender): every sentence from
//    verticalsData.js / compareData.js for a page is in that page's
//    pre-rendered HTML, word for word, and the pages carry no dashes the
//    site's style rules out, no "($X)" placeholders and no fee claims.
//
// Without a build the copy half prints a notice and is skipped.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERTICALS, VERTICAL_GROUPS, POPULAR_VERTICALS } from '../src/features/marketing/verticalsData.js';
import { COMPETITORS, FEATURE_ROWS } from '../src/features/marketing/compareData.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
let checks = 0;
function check(cond, msg) { checks++; if (!cond) failures.push(msg); }

// ── 1. Data wiring ──
const slugs = Object.keys(VERTICALS);
const grouped = VERTICAL_GROUPS.flatMap(([, s]) => s);
for (const s of slugs) check(grouped.filter((g) => g === s).length === 1, `${s} must be in exactly one VERTICAL_GROUPS group`);
for (const g of grouped) check(VERTICALS[g], `VERTICAL_GROUPS lists unknown slug ${g}`);
for (const s of POPULAR_VERTICALS) check(VERTICALS[s], `POPULAR_VERTICALS lists unknown slug ${s}`);
check(POPULAR_VERTICALS.length >= 9, 'POPULAR_VERTICALS needs 9 so every /for page can show 8 others');

for (const [s, v] of Object.entries(VERTICALS)) {
  check(Array.isArray(v.use) && v.use.length >= 2 && v.use.length <= 3, `${s}: use must be 2-3 setup steps`);
  check([2, 3, 4].includes(v.bullets.length), `${s}: ${v.bullets.length} bullets would leave an orphan card`);
}
for (const [s, c] of Object.entries(COMPETITORS)) {
  check(Array.isArray(c.related) && c.related.length >= 3, `/vs/${s}: needs 3+ related /for pages`);
  for (const r of c.related || []) check(VERTICALS[r], `/vs/${s}: related lists unknown slug ${r}`);
}

const src = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const chrome = src('src/features/marketing/site/Chrome.jsx');
const footer = chrome.slice(chrome.indexOf('FOOTER_VERTICALS = ['), chrome.indexOf('];', chrome.indexOf('FOOTER_VERTICALS = [')));
const footerSlugs = [...footer.matchAll(/\['([a-z-]+)', '/g)].map((m) => m[1]);
check(footerSlugs.length >= 8, 'footer "Who it\'s for" column should link 8+ /for pages');
for (const s of footerSlugs) check(VERTICALS[s], `footer links unknown /for/${s}`);
check(chrome.includes('href="/features#who"'), 'footer must link "All businesses" to /features#who');
check(src('src/features/marketing/site/SiteFeatures.jsx').includes('id="who"'), '/features needs the #who directory');

const home = src('src/features/marketing/site/SiteHome.jsx');
const personas = home.slice(home.indexOf('PERSONA_PAGES = {'), home.indexOf('};', home.indexOf('PERSONA_PAGES = {')));
const personaSlugs = [...personas.matchAll(/\['([a-z-]+)', '/g)].map((m) => m[1]);
check(personaSlugs.length >= 5, 'home page persona tabs should link their /for pages');
for (const s of personaSlugs) check(VERTICALS[s], `home persona links unknown /for/${s}`);

check(src('src/features/marketing/site/SiteCompare.jsx').includes('/vs/${c.slug}'), '/compare must link every /vs page');

// ── 2. Rendered copy ──
const PRE = path.join(ROOT, 'dist', 'prerender');
if (!fs.existsSync(path.join(PRE, 'index.html'))) {
  console.log('vertical-pages.test: dist/prerender not found - copy checks skipped (run `npm run build`).');
} else {
  const decode = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
  const bodyText = (html) => decode(html
    .slice(html.indexOf('<body'))
    .replace(/<style[^]*?<\/style>/g, ' ')
    .replace(/<script[^]*?<\/script>/g, ' ')
    .replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  const pageText = (route) => bodyText(fs.readFileSync(path.join(PRE, `${route}.html`), 'utf8'));
  const banned = [[/[–—]/, 'an em or en dash'], [/\(\$X\)|\$X\b/, 'a "$X" placeholder'],
    [/business OS/i, '"business OS"'], [/no transaction fee|take a cut|zero percent/i, 'a fee claim']];

  for (const [s, v] of Object.entries(VERTICALS)) {
    const route = `/for/${s}`;
    const t = pageText(route);
    const strings = [v.headline, v.sub, `Ivy for ${v.angle}`,
      ...v.bullets.flatMap((b) => [b.title, b.body]),
      ...v.use.map((step) => step.replace(/,$/, ''))];
    for (const str of strings) check(t.includes(norm(str)), `${route}: missing "${str}"`);
    check(v.use.join(' ').length > 0, `${route}: empty setup`);
    for (const other of slugs) check(other === s || t.includes(VERTICALS[other].angle.charAt(0).toUpperCase() + VERTICALS[other].angle.slice(1)), `${route}: no link text for /for/${other}`);
    for (const [re, what] of banned) check(!re.test(t), `${route}: contains ${what}`);
  }
  for (const [s, c] of Object.entries(COMPETITORS)) {
    const route = `/vs/${s}`;
    const t = pageText(route);
    const strings = [c.headline, c.sub, `Ivy vs ${c.name}`, c.theirPrice, ...c.pains, ...FEATURE_ROWS.map((r) => r.label),
      "We'll move your data over - free.", 'Feature-by-feature comparison', 'Why solo owners switch', 'Considering other tools?'];
    for (const str of strings) check(t.includes(norm(str)), `${route}: missing "${str}"`);
    const html = fs.readFileSync(path.join(PRE, `${route}.html`), 'utf8');
    for (const r of c.related) check(html.includes(`href="/for/${r}"`), `${route}: no link to /for/${r}`);
    for (const [re, what] of banned) check(!re.test(t), `${route}: contains ${what}`);
  }
  // Internal links that give the /for and /vs pages a referring page.
  const homeHtml = fs.readFileSync(path.join(PRE, 'index.html'), 'utf8');
  for (const s of footerSlugs) check(homeHtml.includes(`href="/for/${s}"`), `/: footer link to /for/${s} missing`);
  const features = fs.readFileSync(path.join(PRE, 'features.html'), 'utf8');
  for (const s of slugs) check(features.includes(`href="/for/${s}"`), `/features: no link to /for/${s}`);
  const compare = fs.readFileSync(path.join(PRE, 'compare.html'), 'utf8');
  for (const s of Object.keys(COMPETITORS)) check(compare.includes(`href="/vs/${s}"`), `/compare: no link to /vs/${s}`);
}

if (failures.length) {
  console.error(`vertical-pages.test: ${failures.length} of ${checks} checks failed:`);
  for (const f of failures) console.error('  ' + f);
  process.exit(1);
}
console.log(`vertical-pages.test: ${checks} checks passed.`);
process.exit(0);
