// Published-site renderer: owner JSON cannot inject markup through section
// ids or link targets.
// Run: node --import ./tests/bootstrap.mjs ./tests/site-html-safety.test.mjs
import { renderSiteHtml, safeHref, safeSectionId } from '../api/_lib/siteHtml.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

console.log('\n[1] safeHref allowlist');
for (const ok of ['https://a.example/x?y=1', 'http://a.example', 'mailto:a@b.co', 'tel:+1555', 'sms:+1555', '/book/x', '#gallery', 'HTTPS://CAPS.example']) {
  assert(safeHref(ok) === ok, `kept: ${ok}`);
}
for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,hi', 'vbscript:x', '//evil.example/x', 'about', 'www.example.com', '', null, 'java\tscript:alert(1)']) {
  assert(safeHref(bad) === '#', `neutralised to #: ${JSON.stringify(bad)}`);
}

console.log('\n[2] safeSectionId');
assert(safeSectionId('hero-1_A') === 'hero-1_A', 'plain id kept');
assert(safeSectionId('"]{} </style><script>x</script>', 3) === 'ivy-sec-3', 'hostile id replaced by a generated one');
assert(safeSectionId('a'.repeat(65), 0) === 'ivy-sec-0', 'over-long id replaced');
assert(safeSectionId(null, 2) === 'ivy-sec-2', 'missing id replaced');

console.log('\n[3] end-to-end render');
const evilId = '"]{}</style><script>alert(1)</script><div x="';
const html = renderSiteHtml({
  site: { template: 'clean', businessName: 'Glow Studio', stickyCta: { enabled: true, text: 'Call', link: 'javascript:alert(2)' } },
  page: {
    title: 'Home',
    sections: [
      { id: evilId, type: 'hero', visible: true, style: { hideOnMobile: true }, data: { headline: 'Hi', cta: 'Go', ctaLink: 'javascript:alert(3)' } },
      { id: 'vid', type: 'video', visible: true, data: { videoUrl: 'data:text/html,<script>alert(4)</script>' } },
      { id: 'ok', type: 'hero', visible: true, style: { hideOnDesktop: true }, data: { headline: 'Two', cta: 'Book', ctaLink: 'https://cal.example/book' } },
    ],
  },
  nav: [], handle: 'glow', currentSlug: '', host: 'joinivy.ai',
});
assert(!/<script>alert\(1\)/.test(html), 'section id cannot break out of <style> / attribute');
assert(/\[data-section-id="ivy-sec-0"\]/.test(html) && /data-section-id="ivy-sec-0"/.test(html), 'hostile section id rendered as a generated id in CSS and attribute');
assert(/\[data-section-id="ok"\]/.test(html), 'well-formed section id kept');
assert(!/javascript:/i.test(html) && !/data:text\/html/i.test(html), 'no javascript:/data: targets anywhere');
assert(/href="#"/.test(html), 'bad targets render as #');
assert(/href="https:\/\/cal\.example\/book"/.test(html), 'https CTA kept');

console.log('\n[4] JSON-LD cannot close its <script> tag');
const ldHtml = renderSiteHtml({
  site: { template: 'clean', businessName: 'Glow</script><meta http-equiv="refresh" content="0;url=https://evil.example">' },
  page: {
    title: 'Home',
    sections: [
      { id: 'c', type: 'contact', visible: true, data: { email: 'a@b.co</SCRIPT><b>x</b>', phone: '1' } },
      { id: 't', type: 'testimonials', visible: true, data: { items: [{ text: 'hi', name: 'n' }] } },
    ],
  },
  nav: [], handle: 'glow', currentSlug: '', host: 'joinivy.ai',
});
const ld = ldHtml.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/i);
assert(!!ld, 'JSON-LD block present');
assert(ld && !/<\//.test(ld[1]), 'no "</" inside the JSON-LD block');
assert(!/<meta http-equiv=\\?"refresh/i.test(ldHtml), 'business name cannot inject a meta refresh');
let parsed = null;
try { parsed = JSON.parse(ld[1]); } catch { /* fails below */ }
assert(parsed && parsed.name.startsWith('Glow</script>'), 'JSON-LD still parses to the exact business name');
assert(parsed && parsed.email === 'a@b.co</SCRIPT><b>x</b>', 'contact email kept exactly in JSON-LD');

console.log('\n[5] owner text with $ patterns is rendered literally');
const dollars = ["Price $` here", "Was $' now", 'Deal $& done', 'Tier $$$'];
const dHtml = renderSiteHtml({
  site: { template: 'clean', businessName: 'Cash $& Carry', seoDescription: "Only $` today" },
  page: {
    title: 'Home',
    sections: dollars.map((h, i) => ({ id: `d${i}`, type: 'hero', visible: true, data: { headline: h } })),
  },
  nav: [], handle: 'cash', currentSlug: '', host: 'joinivy.ai',
});
for (const h of dollars) assert(dHtml.includes(`<h1>${h.replace(/&/g, '&amp;').replace(/'/g, '&#39;')}</h1>`), `headline kept literally: ${h}`);
assert(dHtml.includes('<title>Cash $&amp; Carry</title>'), 'title kept literally');
assert(dHtml.includes('content="Only $` today"'), 'description kept literally');
assert((dHtml.match(/<!doctype html>/gi) || []).length === 1, 'page shell appears exactly once');
assert((dHtml.match(/<\/head>/gi) || []).length === 1, 'exactly one </head>');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
