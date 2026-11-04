// Website editor undo history (src/features/website/history.js), pure logic:
//   [1] typing in one field within the window is ONE step; another field,
//       a pause, or a discrete change starts a new step
//   [2] style / layout changes and structural changes never coalesce
//   [3] undo / redo walk the steps; new edits clear redo
//   [4] publishing is the save point: undo and redo are cleared
//   [5] memory cap by step count and by bytes, oldest dropped first
//   [6] persistence: restored only when publishedAt matches and the newest
//       snapshot equals the server's draft (an Ivy edit, a publish elsewhere
//       or junk in storage all start fresh); the stored size is capped
//
// Run: node --import ./tests/bootstrap.mjs ./tests/website-history.test.mjs
import * as H from '../src/features/website/history.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

const baseSite = () => ({
  businessName: 'Maple', handle: 'maple', template: 'clean', fontPair: null, customCss: '',
  visibility: 'public', seoTitle: '', seoDescription: '', seoOgImage: '', faviconUrl: '',
  redirects: [], formDestinations: [], exitIntentPopup: null, stickyCta: null,
  publishedAt: '2026-11-01T10:00:00.000Z', launched: true,
  pages: [
    { id: 'home', slug: '', title: 'Home', inNav: true, sections: [
      { id: 's1', type: 'hero', visible: true, data: { headline: 'Hi', sub: 'There' }, style: { bg: '#fff' } },
      { id: 's2', type: 'about', visible: true, data: { title: 'About' } },
    ] },
    { id: 'p2', slug: 'about', title: 'About', inNav: true, sections: [] },
  ],
});

// The editor's update shape: copy only the changed branch.
const setData = (site, secId, patch) => ({
  ...site,
  pages: site.pages.map((p) => ({
    ...p,
    sections: p.sections.map((s) => (s.id === secId ? { ...s, data: { ...s.data, ...patch } } : s)),
  })),
});
const setSec = (site, secId, patch) => ({
  ...site,
  pages: site.pages.map((p) => ({
    ...p,
    sections: p.sections.map((s) => (s.id === secId ? { ...s, ...patch } : s)),
  })),
});

// Drive the history the way state.js does.
function editor(start) {
  let site = start;
  let snap = H.snapshotOf(site);
  let h = H.emptyHistory(site.publishedAt);
  return {
    get site() { return site; },
    get h() { return h; },
    set h(v) { h = v; },
    get snap() { return snap; },
    change(next, now) {
      const nextSnap = H.snapshotOf(next);
      if (nextSnap !== snap) h = H.recordChange(h, snap, H.coalesceKey(H.draftOf(site), H.draftOf(next)), now);
      site = next; snap = nextSnap;
    },
    undo() { const r = H.undoStep(h, snap); if (!r) return false; h = r.history; snap = r.snap; site = { ...site, ...JSON.parse(r.snap) }; return true; },
    redo() { const r = H.redoStep(h, snap); if (!r) return false; h = r.history; snap = r.snap; site = { ...site, ...JSON.parse(r.snap) }; return true; },
  };
}

const headline = (site) => site.pages[0].sections[0].data.headline;

function run() {
  console.log('[1] coalescing');
  {
    const e = editor(baseSite());
    let t = 1000;
    for (const v of ['Hi ', 'Hi t', 'Hi th', 'Hi the', 'Hi ther', 'Hi there']) { e.change(setData(e.site, 's1', { headline: v }), t); t += 150; }
    assert(e.h.past.length === 1, 'typing a word in one field within the window is one undo step');
    e.undo();
    assert(headline(e.site) === 'Hi', 'one undo reverts the whole word');
    e.redo();
    assert(headline(e.site) === 'Hi there', 'redo brings the whole word back');

    const e2 = editor(baseSite());
    e2.change(setData(e2.site, 's1', { headline: 'A' }), 1000);
    e2.change(setData(e2.site, 's1', { headline: 'AB' }), 1500);
    e2.change(setData(e2.site, 's1', { headline: 'ABC' }), 3000);
    assert(e2.h.past.length === 2, 'a pause longer than the window starts a new step');

    const e3 = editor(baseSite());
    e3.change(setData(e3.site, 's1', { headline: 'A' }), 1000);
    e3.change(setData(e3.site, 's1', { sub: 'B' }), 1100);
    e3.change(setData(e3.site, 's2', { title: 'C' }), 1200);
    assert(e3.h.past.length === 3, 'a different field (or section) is a new step');

    const e4 = editor(baseSite());
    e4.change({ ...e4.site, seoTitle: 'M' }, 1000);
    e4.change({ ...e4.site, seoTitle: 'Ma' }, 1200);
    assert(e4.h.past.length === 1, 'site-level text (SEO title) coalesces too');

    const e5 = editor(baseSite());
    e5.change(setData(e5.site, 's1', { headline: 'A' }), 1000);
    assert(e5.undo(), 'undo works mid-run');
    e5.change(setData(e5.site, 's1', { headline: 'X' }), 1100);
    assert(e5.h.past.length === 1 && e5.h.future.length === 0, 'typing after an undo starts a fresh step and clears redo');
    assert(H.coalesceKey(H.draftOf(baseSite()), H.draftOf(setData(baseSite(), 's1', { headline: 'Z' }))) === 'sec:home:s1:headline',
      'the coalesce key names page, section and field');
  }

  console.log('[2] discrete changes never coalesce');
  {
    const e = editor(baseSite());
    e.change(setSec(e.site, 's1', { style: { bg: '#000' } }), 1000);
    e.change(setSec(e.site, 's1', { style: { bg: '#111' } }), 1100);
    assert(e.h.past.length === 2, 'style changes are one step each');
    const e2 = editor(baseSite());
    e2.change(setSec(e2.site, 's1', { variant: 'split' }), 1000);
    e2.change(setSec(e2.site, 's1', { variant: 'center' }), 1100);
    assert(e2.h.past.length === 2, 'layout variant changes are one step each');
    const e3 = editor(baseSite());
    const add = (s) => ({ ...s, pages: s.pages.map((p, i) => (i === 0 ? { ...p, sections: [...p.sections, { id: `n${p.sections.length}`, type: 'faq', visible: true, data: {} }] } : p)) });
    e3.change(add(e3.site), 1000);
    e3.change(add(e3.site), 1050);
    assert(e3.h.past.length === 2, 'adding sections is one step each');
    const moved = { ...e3.site, pages: e3.site.pages.map((p, i) => (i === 0 ? { ...p, sections: p.sections.slice().reverse() } : p)) };
    e3.change(moved, 1100);
    assert(e3.h.past.length === 3, 'a reorder is its own step');
    e3.change({ ...e3.site, template: 'warm' }, 1150);
    e3.change({ ...e3.site, template: 'bold' }, 1160);
    assert(e3.h.past.length === 5, 'template changes are one step each');
    assert(H.coalesceKey(H.draftOf(baseSite()), H.draftOf(setSec(baseSite(), 's1', { visible: false }))) === null, 'hiding a section is discrete');
  }

  console.log('[3] undo / redo');
  {
    const e = editor(baseSite());
    e.change({ ...e.site, template: 'warm' }, 1000);
    e.change({ ...e.site, template: 'bold' }, 2000);
    assert(e.undo() && e.site.template === 'warm', 'undo restores the previous step');
    assert(e.undo() && e.site.template === 'clean', 'undo again restores the original');
    assert(!e.undo(), 'nothing left to undo at the start');
    assert(e.redo() && e.site.template === 'warm', 'redo re-applies');
    e.change({ ...e.site, template: 'mono' }, 3000);
    assert(!H.canRedo(e.h), 'a new edit clears redo');
  }

  console.log('[4] publish is the save point');
  {
    const e = editor(baseSite());
    e.change({ ...e.site, template: 'warm' }, 1000);
    e.change({ ...e.site, template: 'bold' }, 2000);
    e.undo();
    e.h = H.markPublished(e.h, '2026-11-04T12:00:00.000Z');
    assert(!H.canUndo(e.h) && !H.canRedo(e.h), 'publishing clears undo and redo');
    assert(e.h.publishedAt === '2026-11-04T12:00:00.000Z', 'history remembers the new publish time');
  }

  console.log('[5] memory cap');
  {
    let h = H.emptyHistory(null);
    for (let i = 0; i < H.MAX_STEPS + 25; i++) h = H.recordChange(h, `{"n":${i}}`, null, i * 5000);
    assert(h.past.length === H.MAX_STEPS, `step cap holds at ${H.MAX_STEPS}`);
    assert(h.past[0] === '{"n":25}', 'the oldest steps are dropped first');
    const big = 'x'.repeat(1024 * 1024);
    let hb = H.emptyHistory(null);
    for (let i = 0; i < 8; i++) hb = H.recordChange(hb, `${i}${big}`, null, i * 5000);
    assert(hb.bytes <= H.MAX_BYTES && hb.past.length < 8, 'byte cap drops the oldest snapshots');
    assert(hb.past[hb.past.length - 1].startsWith('7'), 'the newest snapshot is kept');
    assert(hb.bytes === hb.past.reduce((n, s) => n + s.length, 0), 'byte count stays exact');
  }

  console.log('[6] persistence');
  {
    const e = editor(baseSite());
    e.change({ ...e.site, template: 'warm' }, 1000);
    e.change(setData(e.site, 's1', { headline: 'New' }), 3000);
    const raw = H.serializeHistory(e.h, e.snap);
    assert(typeof raw === 'string', 'history serializes');

    // Server returns the same draft, in another key order and with empty
    // values left out (as the PUT sanitizer does).
    const server = JSON.parse(JSON.stringify(e.site));
    server.pages = server.pages.map((p) => { const { inNav: _inNav, ...rest } = p; return { sections: rest.sections, title: rest.title, slug: rest.slug, id: rest.id }; });
    server.customCss = null;
    const restored = H.restoreHistory(raw, { serverDraft: H.draftOf(server), publishedAt: '2026-11-01T10:00:00Z' });
    assert(restored && restored.past.length === 2, 'restored when the draft and publish match (key order and empty values ignored)');
    const r = H.undoStep(restored, e.snap);
    assert(r && JSON.parse(r.snap).pages[0].sections[0].data.headline === 'Hi', 'undo after reload still works');

    const ivyEdited = setData(e.site, 's2', { title: 'Changed by Ivy' });
    assert(H.restoreHistory(raw, { serverDraft: H.draftOf(ivyEdited), publishedAt: '2026-11-01T10:00:00Z' }) === null,
      'a draft changed elsewhere (e.g. by Ivy) starts fresh');
    assert(H.restoreHistory(raw, { serverDraft: H.draftOf(e.site), publishedAt: '2026-11-05T10:00:00Z' }) === null,
      'a newer publish starts fresh');
    assert(H.restoreHistory(raw, { serverDraft: H.draftOf(e.site), publishedAt: null }) === null,
      'an unpublished site does not take a history from a published one');
    assert(H.restoreHistory('{not json', { serverDraft: H.draftOf(e.site), publishedAt: null }) === null, 'junk in storage is ignored');
    assert(H.restoreHistory(JSON.stringify({ v: 99, current: '{}', past: [], future: [] }), { serverDraft: {}, publishedAt: null }) === null,
      'an unknown storage version is ignored');
    assert(H.restoreHistory(JSON.stringify({ v: 1, publishedAt: null, current: e.snap, past: [1, 2], future: [] }),
      { serverDraft: H.draftOf(e.site), publishedAt: null }) === null, 'malformed steps are ignored');

    const small = H.serializeHistory(e.h, e.snap, e.snap.length + 300);
    const parsed = JSON.parse(small);
    assert(parsed.past.length < 2, 'stored copy drops the oldest steps to fit the size cap');
    assert(H.serializeHistory(e.h, e.snap, 10) === null, 'nothing is stored when even the current draft is too big');

    assert(H.storageKey('ivy_site_history:', 'u1', 'w1') === 'ivy_site_history:u1:w1', 'storage key is per user and site');
    assert(H.storageKey('ivy_site_history:', null, 'w1') === null, 'no user, no storage');
    assert(!H.DRAFT_KEYS.includes('customDomain') && !H.DRAFT_KEYS.includes('publishedAt'),
      'undo never touches the custom domain or publish state');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
run();
