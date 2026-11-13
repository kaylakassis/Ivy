// Moving and copying website sections between pages
// (src/features/website/pageTransforms.js), pure logic:
//   [1] move appends (bottom) or prepends (top), removes from the source,
//       leaves other pages and the input untouched
//   [2] copy deep-clones with a fresh id, original stays
//   [3] buttons on the old page that scrolled to a moved section now open
//       the page it moved to; links that still resolve are left alone
//   [4] edge cases: unknown ids, same page, slugs for new pages, drag math
//
// Run: node --import ./tests/bootstrap.mjs ./tests/website-page-transforms.test.mjs
import {
  moveSectionToPage, copySectionToPage, cloneSection, uniquePageSlug,
  moveSectionWithinPage, dropGapToIndex, findSectionPage,
} from '../src/features/website/pageTransforms.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

const pages = () => ([
  { id: 'home', slug: '', title: 'Home', inNav: true, sections: [
    { id: 'hero', type: 'hero', visible: true, data: { headline: 'Hi', ctaLink: '#gallery' } },
    { id: 'gal', type: 'gallery', visible: true, data: { title: 'Work', images: [{ id: 'i1', url: 'https://x/1.jpg' }] }, style: { bg: '#fff' } },
    { id: 'cta', type: 'cta_banner', visible: true, data: { ctaLink: '#contact' } },
    { id: 'con', type: 'contact', visible: true, data: {} },
  ] },
  { id: 'about', slug: 'about', title: 'About', inNav: true, sections: [
    { id: 'ab', type: 'about', visible: true, data: { title: 'Me' } },
  ] },
  { id: 'port', slug: 'portfolio', title: 'Portfolio', inNav: true, sections: [] },
]);
const ids = (ps, pid) => ps.find((p) => p.id === pid).sections.map((s) => s.id);

function run() {
  console.log('[1] move');
  {
    const input = pages();
    const frozen = JSON.stringify(input);
    const r = moveSectionToPage(input, 'gal', 'about', 'bottom');
    assert(r.moved, 'move reports success');
    assert(JSON.stringify(ids(r.pages, 'home')) === JSON.stringify(['hero', 'cta', 'con']), 'section is removed from its old page');
    assert(JSON.stringify(ids(r.pages, 'about')) === JSON.stringify(['ab', 'gal']), 'Bottom appends to the target page');
    assert(r.pages.find((p) => p.id === 'about').sections[1] === input[0].sections[1], 'moved section keeps its id and content');
    assert(JSON.stringify(input) === frozen, 'input pages are not mutated');
    assert(r.pages.find((p) => p.id === 'port') === input[2], 'untouched pages keep their identity');
    const top = moveSectionToPage(pages(), 'con', 'about', 'top');
    assert(JSON.stringify(ids(top.pages, 'about')) === JSON.stringify(['con', 'ab']), 'Top puts it first');
    const empty = moveSectionToPage(pages(), 'hero', 'port');
    assert(JSON.stringify(ids(empty.pages, 'port')) === JSON.stringify(['hero']), 'moving onto an empty page works');
  }

  console.log('[2] copy');
  {
    let n = 0;
    const mk = () => `new${++n}`;
    const input = pages();
    const r = copySectionToPage(input, 'gal', 'about', 'top', mk);
    assert(r.copied && r.newId === 'new1', 'copy reports the new id');
    assert(JSON.stringify(ids(r.pages, 'home')) === JSON.stringify(['hero', 'gal', 'cta', 'con']), 'the original stays on its page');
    const copy = r.pages.find((p) => p.id === 'about').sections[0];
    assert(copy.id === 'new1' && copy.type === 'gallery', 'the copy lands on the target page with a fresh id');
    copy.data.images[0].url = 'changed';
    copy.style.bg = 'changed';
    assert(input[0].sections[1].data.images[0].url === 'https://x/1.jpg' && input[0].sections[1].style.bg === '#fff',
      'the copy is a deep clone (editing it never changes the original)');
    const same = copySectionToPage(pages(), 'gal', 'home', 'bottom', mk);
    assert(same.copied && ids(same.pages, 'home').length === 5, 'copying onto the same page is allowed');
    const c = cloneSection({ id: 'a', type: 'faq', data: { items: [{ q: 'x' }] } }, () => 'b');
    assert(c.id === 'b' && c.data.items[0].q === 'x' && c.style && typeof c.style === 'object', 'cloneSection matches duplicate behaviour');
  }

  console.log('[3] anchor links on the old page');
  {
    // Hero button "#gallery" scrolled to the gallery on Home. Move the
    // gallery to Portfolio: the button now opens the Portfolio page.
    const r = moveSectionToPage(pages(), 'gal', 'port');
    const hero = r.pages[0].sections.find((s) => s.id === 'hero');
    assert(hero.data.ctaLink === '#portfolio' && r.relinked === 1, 'a "#gallery" button on Home now opens the Portfolio page');
    const cta = r.pages[0].sections.find((s) => s.id === 'cta');
    assert(cta.data.ctaLink === '#contact', 'unrelated anchor links are untouched');

    // Moving to the home page: the link becomes #home.
    const ps = pages();
    ps[1].sections.push({ id: 'btn', type: 'cta_banner', visible: true, data: { ctaLink: '#about' } });
    const r2 = moveSectionToPage(ps, 'ab', 'home');
    const btn = r2.pages[1].sections.find((s) => s.id === 'btn');
    assert(btn.data.ctaLink === '#about', 'a link that still resolves (here, to the About page itself) is left alone');

    const ps3 = pages();
    ps3[1].sections.push({ id: 'b2', type: 'cta_banner', visible: true, data: { ctaLink: '#team' } });
    ps3[1].sections.push({ id: 'tm', type: 'team', visible: true, data: {} });
    const r3 = moveSectionToPage(ps3, 'tm', 'home');
    assert(r3.pages[1].sections.find((s) => s.id === 'b2').data.ctaLink === '#home', 'moving to Home points the button at #home');

    // Another gallery is still on the page: the link still resolves there.
    const ps4 = pages();
    ps4[0].sections.push({ id: 'gal2', type: 'gallery', visible: true, data: {} });
    const r4 = moveSectionToPage(ps4, 'gal', 'port');
    assert(r4.relinked === 0 && r4.pages[0].sections[0].data.ctaLink === '#gallery',
      'when another section still answers the link, nothing is rewritten');

    // Target page hidden from the nav: cannot be linked by name, so warn.
    const ps5 = pages();
    ps5[2].inNav = false;
    const r5 = moveSectionToPage(ps5, 'gal', 'port');
    assert(r5.moved && r5.relinked === 0 && r5.unlinked === 1, 'a target the link cannot reach is reported, not rewritten');

    // The copy never rewrites anything.
    const c = copySectionToPage(pages(), 'gal', 'port');
    assert(c.pages[0].sections[0].data.ctaLink === '#gallery', 'copying leaves links alone');
  }

  console.log('[4] edge cases');
  {
    const ps = pages();
    assert(moveSectionToPage(ps, 'nope', 'about').moved === false, 'unknown section: no move');
    assert(moveSectionToPage(ps, 'gal', 'nope').moved === false, 'unknown page: no move');
    const same = moveSectionToPage(ps, 'gal', 'home');
    assert(same.moved === false && same.pages === ps, 'moving to its own page is a no-op');
    assert(copySectionToPage(ps, 'nope', 'about').copied === false, 'unknown section: no copy');
    assert(findSectionPage(ps, 'ab').id === 'about', 'findSectionPage finds the owning page');

    assert(uniquePageSlug('About', ps) === 'about-2', 'new page slug avoids an existing one');
    assert(uniquePageSlug('Meet the Team!', ps) === 'meet-the-team', 'slug is lowercase with inner hyphens only');
    assert(uniquePageSlug('', ps) === 'page' && uniquePageSlug('***', ps) === 'page', 'empty or symbol-only names fall back to "page"');
    const long = uniquePageSlug('x'.repeat(80) + ' y', []);
    assert(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(long), 'long names still give a slug the server accepts');
    const many = [{ slug: 'page' }, { slug: 'page-2' }];
    assert(uniquePageSlug('', many) === 'page-3', 'dedupe keeps counting');
    // 1.0.7: a rename can never produce an address that blocks saving.
    const site = [{ id: 'h', slug: '' }, { id: 'a', slug: 'services' }, { id: 'b', slug: 'page-3' }];
    assert(uniquePageSlug('Services', site, 'a') === 'services', 'renaming a page to its own name keeps its address');
    assert(uniquePageSlug('Services', site, 'b') === 'services-2', 'renaming to a name another page uses gets its own address');
    assert(uniquePageSlug('\u2728\u2728', site, 'b') === 'page' && uniquePageSlug('\u5173\u4e8e', site) === 'page', 'emoji or another alphabet falls back to "page", never empty (empty is the home page)');
    assert(uniquePageSlug('Caf\u00e9 Men\u00fa', site) === 'cafe-menu', 'accents are folded');
    assert(uniquePageSlug('page-3', site) === 'page-3-2', 'adding a page after deleting one cannot reuse a taken address');
    assert(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(uniquePageSlug('-- A  b__c --', site)), 'always matches what the server accepts');

    const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
    assert(dropGapToIndex(0, 2) === 0 && dropGapToIndex(4, 1) === 3, 'drop gap maps to a moveTo index');
    assert(dropGapToIndex(2, 2) === null && dropGapToIndex(3, 2) === null, 'dropping next to itself is no move');
    assert(moveSectionWithinPage(list, 'a', 3).map((x) => x.id).join('') === 'bcda', 'moveWithinPage to the end');
    assert(moveSectionWithinPage(list, 'a', 0) === list, 'same position returns the same array');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
run();
