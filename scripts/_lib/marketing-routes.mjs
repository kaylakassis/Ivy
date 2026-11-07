// The one list of public marketing pages, shared by the build-time
// pre-render (scripts/prerender.mjs), the sitemap and the SEO check
// (tests/prerender.test.mjs). Vertical and competitor slugs come straight
// from the data the site itself renders, so the sitemap and the
// pre-rendered pages cannot drift from the routes; blog posts are whatever
// is in public/blog.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERTICALS } from '../../src/features/marketing/verticalsData.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Canonical public origin. Kept in step with SITE_ORIGIN in
// src/lib/pageMeta.js (the test asserts every canonical uses it).
export const SITE_ORIGIN = 'https://www.joinivy.ai';

// Files whose last change should bump <lastmod> for every page: the shared
// chrome and the head helper.
const SHARED = ['src/features/marketing/site/Chrome.jsx', 'src/lib/pageMeta.js'];
const SITE = (f) => `src/features/marketing/site/${f}`;
const MKT = (f) => `src/features/marketing/${f}`;
const LEGAL = (f) => `src/features/legal/${f}`;
const TOOL = (f) => `src/features/marketing/tools/${f}`;

// `sources` are the repo files whose git history dates the page.
const STATIC_PAGES = [
  { path: '/',             priority: '1.0', sources: [SITE('SiteHome.jsx'), 'src/lib/pricing.js'] },
  { path: '/pricing',      priority: '0.9', sources: [SITE('SitePricing.jsx'), 'src/lib/pricing.js'] },
  { path: '/tour',         priority: '0.8', sources: [SITE('SiteTour.jsx')] },
  { path: '/features',     priority: '0.8', sources: [SITE('SiteFeatures.jsx')] },
  { path: '/about',        priority: '0.6', sources: [SITE('SiteAbout.jsx')] },
  { path: '/support',      priority: '0.6', sources: [SITE('SiteSupport.jsx')] },
  { path: '/security',     priority: '0.6', sources: [MKT('SecurityPage.jsx')] },
  { path: '/mobile',       priority: '0.6', sources: [MKT('MobilePage.jsx')] },
  { path: '/integrations', priority: '0.6', sources: [MKT('IntegrationsPage.jsx')] },
  // Free tools (src/features/marketing/tools/toolsData.js lists them).
  { path: '/tools',                                 priority: '0.7', sources: [TOOL('ToolsHub.jsx'), TOOL('toolsData.js'), TOOL('toolsUi.jsx')] },
  { path: '/tools/cancellation-policy-generator',   priority: '0.7', sources: [TOOL('CancellationPolicyTool.jsx'), TOOL('policyGenerator.js'), TOOL('toolsUi.jsx')] },
  { path: '/tools/deposit-calculator',              priority: '0.7', sources: [TOOL('DepositCalculatorTool.jsx'), TOOL('depositMath.js'), TOOL('toolsUi.jsx')] },
  { path: '/tools/intake-form-templates',           priority: '0.7', sources: [TOOL('IntakeTemplatesTool.jsx'), TOOL('intakeTemplates.js'), TOOL('toolsUi.jsx')] },
  { path: '/privacy',      priority: '0.3', sources: [LEGAL('PrivacyPage.jsx'), LEGAL('LegalPage.jsx')] },
  { path: '/terms',        priority: '0.3', sources: [LEGAL('TermsPage.jsx'), LEGAL('LegalPage.jsx')] },
  { path: '/do-not-sell',  priority: '0.3', sources: [LEGAL('DoNotSellPage.jsx'), LEGAL('LegalPage.jsx')] },
];

// Every React-rendered public page that gets pre-rendered.
export function marketingRoutes() {
  const verticals = Object.keys(VERTICALS).map((slug) => ({
    path: `/for/${slug}`, priority: '0.7',
    sources: [MKT('verticalsData.js'), MKT('VerticalPage.jsx')],
  }));
  return [...STATIC_PAGES, ...verticals]
    .map((r) => ({ ...r, sources: [...r.sources, ...SHARED] }));
}

// Where the pre-rendered copy of a route lives under dist/.
export function prerenderFile(routePath) {
  return routePath === '/' ? 'prerender/index.html' : `prerender${routePath}.html`;
}

const decode = (s) => s
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'");

// Static blog posts in public/blog, with their title and publish date.
export function blogPosts() {
  const dir = path.join(ROOT, 'public', 'blog');
  return readdirSync(dir).filter((f) => f.endsWith('.html')).sort().map((f) => {
    const html = readFileSync(path.join(dir, f), 'utf8');
    const slug = f.replace(/\.html$/, '');
    const rawTitle = decode((html.match(/<title>([^<]*)<\/title>/i) || [, ''])[1].trim());
    const title = rawTitle.replace(/\s*\|\s*Ivy Blog\s*$/, '');
    const description = decode((html.match(/<meta name="description" content="([^"]*)"/i) || [, ''])[1]);
    const datePublished = (html.match(/"datePublished":\s*"([^"]+)"/) || [, ''])[1];
    return { slug, path: `/blog/${slug}`, title, description, datePublished, file: `public/blog/${f}` };
  });
}

// Everything the sitemap lists.
export function sitemapEntries() {
  return [
    ...marketingRoutes(),
    { path: '/blog', priority: '0.8', sources: ['public/blog.html'] },
    ...blogPosts().map((p) => ({ path: p.path, priority: '0.6', sources: [p.file] })),
  ];
}
