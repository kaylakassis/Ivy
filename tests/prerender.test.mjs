// SEO check for the pre-rendered marketing site (`npm run check:seo`, also
// the last step of `npm run build` and part of `npm test`).
//
// Serves dist/ through the same stages a request goes through on Vercel
// (middleware.js, filesystem, vercel.json rewrites in order, with their
// host conditions) and asserts, for every public route, what a crawler
// that runs no JavaScript receives: a 200, the pre-rendered document with
// the page's <h1> in the raw HTML, a unique <title>, a description, the
// canonical on the www host, Open Graph + Twitter tags, JSON-LD that
// parses, and an inline script whose hash still matches the CSP. It also
// checks the routes that must NOT get a pre-rendered page (signed-in
// visitors at "/", custom domains, app routes) and the sitemap, robots.txt
// and llms.txt.
//
// Without a build (no dist/prerender) it prints a notice and passes, so the
// database test run stays green on a fresh checkout.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { startDistServer } from '../scripts/_lib/serve-dist.mjs';
import { ROOT, SITE_ORIGIN, marketingRoutes, blogPosts, sitemapEntries } from '../scripts/_lib/marketing-routes.mjs';
import { VERTICALS } from '../src/features/marketing/verticalsData.js';

const DIST = path.join(ROOT, 'dist');

if (!fs.existsSync(path.join(DIST, 'prerender', 'index.html'))) {
  console.log('prerender.test: dist/prerender not found (run `npm run build` first) - nothing to check, passing.');
  process.exit(0);
}

const failures = [];
const warnings = [];
let checks = 0;
function check(cond, msg) { checks++; if (!cond) failures.push(msg); }
function warn(cond, msg) { if (!cond) warnings.push(msg); }

const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'");
const text = (html) => decode(html.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
const attr = (html, re) => { const m = re.exec(html); return m ? decode(m[1]) : null; };
const metaName = (html, name) => attr(html, new RegExp(`<meta name="${name}" content="([^"]*)"`));
const metaProp = (html, prop) => attr(html, new RegExp(`<meta property="${prop}" content="([^"]*)"`));

// Visible headline each static page must carry in its raw HTML (checked
// word for word against the React source, so a route that rendered the
// wrong page or an empty shell fails here).
const EXPECTED_H1 = {
  '/': 'The business platform with an AI that does the work.',
  '/pricing': 'Simple pricing.One plan, no per-seat math.',
  '/tour': 'Everything Ivy does, in 13 stops.',
  '/features': "Everything your business needs.Nothing it doesn't.",
  '/about': 'One tool, made well, that respectsyour data and your time.',
  '/support': 'Stuck on something?',
  '/security': 'Your data. Your clients. Your control.',
  '/mobile': 'Ivy works on every device - starting with the one in your pocket.',
  '/integrations': 'Plays well with what you already use.',
  '/privacy': 'Privacy Policy',
  '/terms': 'Terms of Service',
  '/do-not-sell': 'Do Not Sell or Share My Personal Information',
};
for (const [slug, v] of Object.entries(VERTICALS)) EXPECTED_H1[`/for/${slug}`] = v.headline;

const vercelConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
const middleware = await import(pathToFileURL(path.join(ROOT, 'middleware.js')).href);
const server = await startDistServer({ dist: DIST, mode: 'vercel', vercelConfig, middleware, host: 'www.joinivy.ai' });

async function get(p, headers = {}) {
  const res = await fetch(server.url + p, { headers, redirect: 'manual' });
  return { status: res.status, type: res.headers.get('content-type') || '', body: await res.text() };
}

try {
  const routes = marketingRoutes();
  const titles = new Map();
  const descriptions = new Map();
  const cspHashes = new Set();

  for (const route of routes) {
    const p = route.path;
    const { status, body } = await get(p);
    check(status === 200, `${p}: HTTP ${status}`);
    check(/<html[^>]*\sdata-prerendered="1"/.test(body), `${p}: not the pre-rendered document`);

    const h1 = attr(body, /<h1[^>]*>([^]*?)<\/h1>/);
    check(h1 !== null && text(h1).length > 0, `${p}: no <h1> in raw HTML`);
    if (h1 !== null) check(text(h1) === EXPECTED_H1[p], `${p}: <h1> is "${text(h1)}", expected "${EXPECTED_H1[p]}"`);

    const title = attr(body, /<title>([^<]*)<\/title>/);
    check(!!title, `${p}: no <title>`);
    check(!titles.has(title), `${p}: duplicate <title> "${title}" (also ${titles.get(title)})`);
    titles.set(title, p);
    warn(!title || title.length <= 60, `${p}: title is ${title?.length} chars (> 60): "${title}"`);

    const desc = metaName(body, 'description');
    check(!!desc, `${p}: no meta description`);
    check(!desc || desc.length <= 160, `${p}: description is ${desc?.length} chars (> 160)`);
    check(!descriptions.has(desc), `${p}: duplicate description (also ${descriptions.get(desc)})`);
    descriptions.set(desc, p);

    const canonical = attr(body, /<link rel="canonical" href="([^"]*)"/);
    check(canonical === SITE_ORIGIN + p, `${p}: canonical is "${canonical}"`);
    check(metaProp(body, 'og:url') === SITE_ORIGIN + p, `${p}: og:url wrong`);
    check(metaProp(body, 'og:title') === title, `${p}: og:title differs from <title>`);
    check(metaProp(body, 'og:description') === desc, `${p}: og:description differs from description`);
    check(metaProp(body, 'og:type') === 'website', `${p}: og:type missing`);
    check(metaProp(body, 'og:image') === `${SITE_ORIGIN}/og-image.png`, `${p}: og:image missing`);
    check(metaName(body, 'twitter:card') === 'summary_large_image', `${p}: twitter:card missing`);
    check(metaName(body, 'twitter:image') === `${SITE_ORIGIN}/og-image.png`, `${p}: twitter:image missing`);
    check(!/https?:\/\/joinivy\.ai\//.test(body.slice(0, body.indexOf('</head>'))), `${p}: apex host in <head> (canonical host is www)`);

    const lds = [...body.matchAll(/<script type="application\/ld\+json"[^>]*>([^]*?)<\/script>/g)].map((m) => m[1]);
    for (const ld of lds) {
      let parsed = null;
      try { parsed = JSON.parse(decode(ld)); } catch { /* fails below */ }
      check(parsed && parsed['@context'] === 'https://schema.org', `${p}: JSON-LD does not parse`);
    }
    if (p.startsWith('/for/')) {
      check(lds.some((ld) => ld.includes('"BreadcrumbList"')), `${p}: BreadcrumbList missing`);
    }
    if (p === '/') {
      check(lds.some((ld) => ld.includes('"Organization"') && ld.includes('"SoftwareApplication"')), '/: Organization + SoftwareApplication graph missing');
    }

    // The inline script must be byte-identical to the one the CSP hash covers.
    const inline = attr(body, /<script>([^]*?)<\/script>/);
    const cspHash = attr(body, /script-src 'self' '(sha256-[^']+)'/);
    check(!!inline && !!cspHash, `${p}: inline script or CSP hash missing`);
    if (inline && cspHash) {
      const got = 'sha256-' + createHash('sha256').update(inline).digest('base64');
      check(got === cspHash, `${p}: inline script hash ${got} != CSP ${cspHash}`);
      cspHashes.add(cspHash);
    }
    check(/<script type="module" crossorigin(?:="")? src="\/assets\/[^"]+\.js"><\/script>/.test(body), `${p}: module script missing (React would not boot)`);
    check(body.includes('id="prerender-freeze"'), `${p}: animation freeze style missing`);
  }

  // The free tools (/tools) were taken off the website (the cancellation
  // policy writer lives in the app). Nothing may pre-render or list them,
  // and the old URLs redirect permanently to /features on the www host.
  check(!routes.some((r) => r.path === '/tools' || r.path.startsWith('/tools/')), '/tools must not be pre-rendered');
  check(!fs.existsSync(path.join(DIST, 'prerender', 'tools.html')) && !fs.existsSync(path.join(DIST, 'prerender', 'tools')), 'dist/prerender still has /tools pages');
  check(!vercelConfig.rewrites.some((r) => /^\/tools(\/|$)/.test(r.source)), 'vercel.json still rewrites /tools');
  for (const source of ['/tools', '/tools/:slug']) {
    const r = (vercelConfig.redirects || []).find((x) => x.source === source);
    check(!!r && r.destination === '/features' && r.permanent === true
      && Array.isArray(r.has) && r.has.length === 1 && r.has[0].type === 'host' && r.has[0].value === 'www.joinivy.ai',
    `vercel.json lacks the www-only permanent redirect ${source} -> /features`);
  }
  {
    const home = (await get('/')).body;
    check(!/href="\/tools(?:[/"?#])/.test(home), 'the site footer still links to /tools');
  }

  // The header CSP in vercel.json must allow the same inline script.
  const headerCsp = vercelConfig.headers.find((h) => h.source === '/(.*)').headers.find((h) => h.key === 'Content-Security-Policy').value;
  for (const h of cspHashes) check(headerCsp.includes(`'${h}'`), `vercel.json header CSP lacks ${h}`);

  // Pages that must NOT be the pre-rendered marketing document.
  const shell = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
  const signedIn = await get('/', { cookie: 'ivy_session=abc' });
  check(signedIn.status === 200 && signedIn.body === shell, '/ with a session cookie must serve the SPA shell');
  const dashboard = await get('/dashboard');
  check(dashboard.status === 200 && dashboard.body === shell, '/dashboard must serve the SPA shell');
  const portal = await get('/me/invoices');
  check(portal.status === 200 && portal.body === shell, '/me/invoices must serve the SPA shell');
  const unknownFor = await get('/for/not-a-real-vertical');
  check(unknownFor.status === 200 && unknownFor.body === shell, '/for/<unknown> must fall through to the SPA shell');

  const custom = await startDistServer({ dist: DIST, mode: 'vercel', vercelConfig, middleware, host: 'studio.example.com' });
  try {
    for (const p of ['/', '/pricing', '/for/hair-stylists']) {
      const r = await fetch(custom.url + p).then(async (x) => ({ status: x.status, body: await x.text() }));
      check(r.status === 200 && r.body === shell, `custom domain ${p} must serve the SPA shell, never Ivy's marketing page`);
    }
  } finally { await custom.close(); }

  // Blog stays static and keeps its article text.
  const post = await get('/blog/ivy-vs-honeybook');
  check(post.status === 200 && /<h1/.test(post.body) && !post.body.includes('id="root"'), '/blog/:slug must serve the static post');
  check(metaProp(post.body, 'og:image') === `${SITE_ORIGIN}/og-image.png`, 'blog post lacks og:image');
  check(attr(post.body, /<link rel="canonical" href="([^"]*)"/) === `${SITE_ORIGIN}/blog/ivy-vs-honeybook`, 'blog canonical not on www');
  check(post.body.includes('"BreadcrumbList"'), 'blog post lacks BreadcrumbList');

  // Sitemaps: both URLs, same content, every public page listed once.
  const sm1 = await get('/marketing-sitemap.xml');
  const sm2 = await get('/sitemap.xml');
  check(sm1.status === 200 && /xml/.test(sm1.type), '/marketing-sitemap.xml not served as XML');
  check(sm2.status === 200 && sm2.body === sm1.body, '/sitemap.xml must serve the same sitemap');
  const locs = [...sm1.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  check(new Set(locs).size === locs.length, 'sitemap has duplicate URLs');
  for (const e of sitemapEntries()) check(locs.includes(SITE_ORIGIN + e.path), `sitemap missing ${e.path}`);
  check(locs.every((l) => l.startsWith(SITE_ORIGIN + '/')), 'sitemap URL not on the www host');
  check(!locs.some((l) => /\/tools(\/|$)/.test(l)), 'sitemap still lists /tools');
  for (const p of ['/privacy', '/terms', '/do-not-sell', '/blog']) check(locs.includes(SITE_ORIGIN + p), `sitemap missing ${p}`);

  // robots.txt + llms.txt
  const robots = await get('/robots.txt');
  check(robots.status === 200, '/robots.txt missing');
  for (const s of ['/sitemap.xml', '/marketing-sitemap.xml']) check(robots.body.includes(`Sitemap: ${SITE_ORIGIN}${s}`), `robots.txt lacks ${s}`);
  for (const ua of ['GPTBot', 'PerplexityBot', 'Google-Extended', 'Bingbot', 'Applebot-Extended', 'OAI-SearchBot', 'CCBot']) {
    check(robots.body.includes(`User-agent: ${ua}`), `robots.txt lacks ${ua}`);
  }
  for (const d of ['/api/', '/dashboard', '/account', '/admin', '/onboarding', '/me', '/sign/', '/invoice/', '/quote/', '/review/', '/p/']) {
    check(robots.body.includes(`Disallow: ${d}`), `robots.txt lacks Disallow: ${d}`);
  }
  for (const f of ['/llms.txt', '/llms-full.txt']) {
    const r = await get(f);
    check(r.status === 200 && r.body.length > 500, `${f} missing`);
    check(!/[–—]/.test(r.body), `${f} contains an en or em dash`);
    check(!/business OS/i.test(r.body), `${f} says "business OS"`);
    check(!/joinivy\.ai\/tools\b|^## Free tools/m.test(r.body), `${f} still lists the removed /tools pages`);
    for (const post of blogPosts()) check(r.body.includes(SITE_ORIGIN + post.path), `${f} lacks ${post.path}`);
  }
  const og = await get('/og-image.png');
  check(og.status === 200 && /image\/png/.test(og.type), '/og-image.png missing');
} finally {
  await server.close();
}

for (const w of warnings) console.log(`  warn: ${w}`);
if (failures.length) {
  console.error(`\nprerender.test: ${failures.length} of ${checks} checks FAILED`);
  for (const f of failures) console.error(`  FAIL: ${f}`);
  process.exit(1);
}
console.log(`prerender.test: ${checks} checks passed across ${marketingRoutes().length} pre-rendered routes (${warnings.length} warnings).`);
