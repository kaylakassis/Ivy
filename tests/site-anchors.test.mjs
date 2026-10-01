// Published-site buttons go somewhere. Templates ship hero buttons that
// point at "#portfolio" while Portfolio is a separate page, and nothing
// on a page carried an id, so every in-page link was a dead click.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/site-anchors.test.mjs
import { sectionAnchors, resolveSiteLink } from '../src/lib/siteLinks.js';
import { renderSiteHtml } from '../api/_lib/siteHtml.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

const home = [
  { id: 'h1', type: 'hero', visible: true, data: { headline: 'Studio', cta: 'View portfolio', ctaLink: '#portfolio' } },
  { id: 'g1', type: 'gallery', visible: true, data: { images: [] } },
  { id: 'g2', type: 'gallery', visible: true, data: { images: [] } },
  { id: 'c1', type: 'cta_banner', visible: true, data: { headline: 'Ready?', cta: 'Get in touch', ctaLink: '#contact' } },
  { id: 'x1', type: 'about', visible: false, data: {} },
  { id: 'f1', type: 'footer', visible: true, data: {} },
];
const nav = [{ slug: '', title: 'Home' }, { slug: 'portfolio', title: 'Portfolio' }, { slug: 'contact', title: 'Contact' }];

console.log('\n[1] anchors');
const anchors = sectionAnchors(home);
assert(anchors.h1 === 'hero' && anchors.g1 === 'gallery' && anchors.g2 === 'gallery-2' && anchors.f1 === 'footer', `type-based ids, de-duplicated (${JSON.stringify(anchors)})`);
assert(!('x1' in anchors), 'hidden sections get no anchor');
assert(sectionAnchors([{ id: 'a', type: 'about', visible: true, anchor: 'Our Story' }]).a === 'our-story', 'a custom anchor wins and is slugified');

console.log('\n[2] link resolution');
const ctx = { anchors, pages: nav, linkBase: '/site/studio', sections: home };
assert(resolveSiteLink('#gallery', ctx) === '#gallery', 'exact anchor stays an anchor');
assert(resolveSiteLink('#portfolio', ctx) === '/site/studio/portfolio', '#portfolio → the Portfolio page when the site has one');
assert(resolveSiteLink('#contact', ctx) === '/site/studio/contact', '#contact → the Contact page (no contact section on this page)');
assert(resolveSiteLink('#work', ctx) === '#gallery', '#work → first gallery via alias when there is no such page');
assert(resolveSiteLink('#home', ctx) === '/site/studio', '#home → site home');
assert(resolveSiteLink('https://x.com', ctx) === 'https://x.com', 'absolute links untouched');
assert(resolveSiteLink('#nothing-here', ctx) === '#nothing-here', 'unknown target left alone');
const ctx2 = { anchors: sectionAnchors(home), pages: [{ slug: '', title: 'Home' }], linkBase: '/site/studio', sections: home };
assert(resolveSiteLink('#portfolio', ctx2) === '#gallery', 'single-page site: #portfolio → the gallery on this page');

console.log('\n[3] server-rendered page');
const html = renderSiteHtml({
  site: { template: 'clean', businessName: 'Studio', handle: 'studio' },
  page: { slug: '', title: 'Home', sections: home },
  nav, handle: 'studio', currentSlug: '', host: 'www.joinivy.ai',
});
assert(/id="gallery"/.test(html) && /id="gallery-2"/.test(html) && /id="footer"/.test(html), 'sections carry anchor ids');
assert(/href="\/site\/studio\/portfolio"/.test(html), 'hero button links to the Portfolio page');
assert(/href="\/site\/studio\/contact"/.test(html), 'banner button links to the Contact page');
assert(/scroll-behavior: smooth/.test(html), 'smooth scrolling for in-page anchors');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
