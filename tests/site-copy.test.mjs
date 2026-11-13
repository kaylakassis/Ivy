// Website copy is plain text: formatting marks never show as symbols on the
// owner's site or in the editor (1.0.7: "users should never see code").
import { cleanSiteCopy, cleanSectionData, cleanSectionCopy, cleanPagesCopy } from '../src/lib/siteCopy.js';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const assert = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const eq = (a, b, m) => assert(a === b, `${m}${a === b ? '' : `  (got ${JSON.stringify(a)})`}`);

console.log('[1] formatting marks become plain words');
eq(cleanSiteCopy('**Certified** trainer since 2015.'), 'Certified trainer since 2015.', 'bold marks removed');
eq(cleanSiteCopy('Hi.<br>See my [story](https://example.com/a?b=1).'), 'Hi.\nSee my story.', 'line break tag and link keep their words');
eq(cleanSiteCopy('<p>One</p><p>Two</p>'), 'One\nTwo', 'paragraph tags become lines');
eq(cleanSiteCopy('<ul><li>Cut</li><li>Color</li></ul>'), '• Cut\n• Color', 'a list becomes bullets');
eq(cleanSiteCopy('## About me\nI help people.'), 'About me\nI help people.', 'heading marks removed');
eq(cleanSiteCopy('Use `code` here and __bold__ too'), 'Use code here and bold too', 'backticks and underscores removed');
eq(cleanSiteCopy('Tom &amp; Jerry&nbsp;Studio'), 'Tom & Jerry Studio', 'entities decoded');
eq(cleanSiteCopy('Hello<script>alert(1)</script> there<style>.a{b:c}</style>'), 'Hello there', 'script and style blocks dropped whole');
eq(cleanSiteCopy('***Big*** news'), 'Big news', 'triple marks removed');

console.log('[2] ordinary text is left exactly as typed');
for (const t of ['*terms apply', '4.9★ rating', '3 < 5 and 7 > 2', '#1 rated in Austin', 'Call me - anytime', 'snake_case_name stays', 'Prices from $85 (60 min)', 'a * b * c', 'Line one\n\n\nLine two', '  padded  ', 'I <3 my clients', 'R&D and Q&A']) {
  eq(cleanSiteCopy(t), t, JSON.stringify(t));
}
assert(cleanSiteCopy(null) === null && cleanSiteCopy(42) === 42 && cleanSiteCopy('') === '', 'non-text values pass through');

console.log('[3] sections: copy cleaned, addresses and code sections untouched');
const data = { headline: '**Welcome**', ctaLink: '#portfolio', imgUrl: 'https://x.test/a__b__c.jpg', videoUrl: 'https://y.test/[a](b)', items: [{ id: 'i1', name: '<b>Cut</b>', desc: 'ok' }], platform: 'tiktok' };
const out = cleanSectionData('hero', data);
assert(out.headline === 'Welcome' && out.items[0].name === 'Cut', 'text fields cleaned, including inside lists');
assert(out.ctaLink === '#portfolio' && out.imgUrl === data.imgUrl && out.videoUrl === data.videoUrl && out.items[0].id === 'i1', 'links, photo addresses and ids untouched');
assert(out.items[0].desc === 'ok' && out !== data && data.headline === '**Welcome**', 'input not mutated');
const same = { headline: 'Plain', items: [{ name: 'A' }] };
assert(cleanSectionData('hero', same) === same, 'nothing to clean: the same object comes back');
const code = { html: '<div>**x**</div>' };
assert(cleanSectionData('custom_html', code) === code && cleanSectionData('code_snippet', { code: '<b>' }).code === '<b>', 'code sections are never rewritten');
const sec = { id: 's1', type: 'about', data: { body: 'A<br>B' } };
assert(cleanSectionCopy(sec).data.body === 'A\nB' && cleanSectionCopy(sec).id === 's1', 'cleanSectionCopy keeps the section');
const pages = cleanPagesCopy([{ slug: '', sections: [sec, { id: 's2', type: 'custom_html', data: code }] }, { slug: 'x' }]);
assert(pages[0].sections[0].data.body === 'A\nB' && pages[0].sections[1].data === code && pages[1].slug === 'x', 'cleanPagesCopy walks every page');

console.log('[4] the builder never prints an internal section name, and photo fields never show an address');
const canvas = readFileSync(new URL('../src/features/website/Canvas.jsx', import.meta.url), 'utf8');
assert(!/\{section\.type\}/.test(canvas) && /SECTION_TYPES\[section\.type\]\?\.label/.test(canvas), 'the selected-section label uses the plain name');
const kit = readFileSync(new URL('../src/features/website/editorKit.jsx', import.meta.url), 'utf8');
const img = kit.slice(kit.indexOf('export function ImageInput'), kit.indexOf('export function GalleryPhotos'));
assert(!/value=\{value \|\| ''\}/.test(img) && /Change photo/.test(img), 'the photo field shows a picture with Change / Remove, not the stored address');
const { SECTION_TYPES } = await import('../src/features/website/sections.js');
assert(Object.values(SECTION_TYPES).every((c) => c.label && !/_/.test(c.label)), 'every section type has a plain label');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
