// Pure page/section transforms for the website editor. No React, so they
// are unit tested in node (tests/website-page-transforms.test.mjs).
import { sectionAnchors, resolveSiteLink } from '../../lib/siteLinks.js';

let idCounter = 0;
export function newSectionId() {
  idCounter += 1;
  return `s_${Date.now().toString(36)}_${Math.floor(Math.random() * 999)}${idCounter}`;
}

// Deep copy of a section with a fresh id. Same cloning duplicateSection has
// always done: data deep-copied, style copied, everything else carried over.
export function cloneSection(sec, makeId = newSectionId) {
  return {
    ...sec,
    id: makeId(),
    data: JSON.parse(JSON.stringify(sec?.data || {})),
    style: { ...(sec?.style || {}) },
  };
}

// Insert index within a list of length n for position 'top' | 'bottom' | n.
function insertAt(list, position) {
  if (position === 'top') return 0;
  if (typeof position === 'number' && Number.isFinite(position)) {
    return Math.max(0, Math.min(list.length, Math.floor(position)));
  }
  return list.length;
}

export function findSectionPage(pages, sectionId) {
  for (const p of pages || []) {
    if ((p.sections || []).some((s) => s.id === sectionId)) return p;
  }
  return null;
}

// Link context the public renderer would use on `page` (siteLinks.js).
function linkCtx(page, pages) {
  const visible = (page.sections || []).filter((s) => s && s.visible !== false);
  return {
    anchors: sectionAnchors(visible),
    pages: (pages || []).filter((p) => p.inNav !== false).map((p) => ({ slug: p.slug || '' })),
    linkBase: '/site/x',
    sections: visible,
    bookingHref: '/book/x',
  };
}

// True when "#key" names a section anchor on the page (same key rules as
// resolveSiteLink in src/lib/siteLinks.js).
function anchorPresent(href, ctx) {
  const key = String(href).trim().slice(1).toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return !!key && Object.values(ctx.anchors).includes(key);
}

// Walk a section's data and rewrite string values that start with '#'.
function mapAnchorLinks(node, fn, depth = 0) {
  if (depth > 20 || node == null) return { node, changed: 0 };
  if (typeof node === 'string') {
    if (!node.trim().startsWith('#')) return { node, changed: 0 };
    const next = fn(node);
    return next === node ? { node, changed: 0 } : { node: next, changed: 1 };
  }
  if (Array.isArray(node)) {
    let changed = 0;
    const out = node.map((x) => { const r = mapAnchorLinks(x, fn, depth + 1); changed += r.changed; return r.node; });
    return changed ? { node: out, changed } : { node, changed: 0 };
  }
  if (typeof node === 'object') {
    let changed = 0;
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      const r = mapAnchorLinks(v, fn, depth + 1);
      changed += r.changed;
      out[k] = r.node;
    }
    return changed ? { node: out, changed } : { node, changed: 0 };
  }
  return { node, changed: 0 };
}

// After a section leaves `before` (its old page), any button on that page
// that scrolled to it ("#gallery") would go nowhere. Point those buttons at
// the page the section now lives on instead ("#portfolio" opens that page).
// Returns { page, relinked, unlinked }; unlinked counts buttons that could
// not be pointed anywhere sensible (target page hidden from the nav, or its
// name clashes with another section on the old page).
function relinkSourcePage(before, after, movedId, targetPage, pagesAfter) {
  const ctxBefore = linkCtx(before, pagesAfter);
  const anchor = ctxBefore.anchors[movedId];
  if (!anchor) return { page: after, relinked: 0, unlinked: 0 };
  const ctxAfter = linkCtx(after, pagesAfter);
  const targetKey = targetPage.slug ? targetPage.slug : 'home';
  const pageHref = targetPage.slug ? `/site/x/${targetPage.slug}` : '/site/x';
  const replacementWorks = resolveSiteLink(`#${targetKey}`, ctxAfter) === pageHref;
  let relinked = 0;
  let unlinked = 0;
  const fn = (href) => {
    if (resolveSiteLink(href, ctxBefore) !== `#${anchor}`) return href;
    const now = resolveSiteLink(href, ctxAfter);
    // Still lands somewhere on the old page or another page: leave it.
    if (now !== href.trim() || anchorPresent(href, ctxAfter)) return href;
    if (replacementWorks) { relinked += 1; return `#${targetKey}`; }
    unlinked += 1;
    return href;
  };
  const sections = (after.sections || []).map((s) => {
    const r = mapAnchorLinks(s.data, fn);
    return r.changed ? { ...s, data: r.node } : s;
  });
  return { page: relinked ? { ...after, sections } : after, relinked, unlinked };
}

// Move a section to another page. position: 'top' | 'bottom' (default) |
// index. Returns { pages, moved, relinked, unlinked }; moved=false (and the
// same pages array) when nothing could move.
export function moveSectionToPage(pages, sectionId, targetPageId, position = 'bottom') {
  const list = Array.isArray(pages) ? pages : [];
  const source = findSectionPage(list, sectionId);
  const target = list.find((p) => p.id === targetPageId);
  if (!source || !target || source.id === target.id) {
    return { pages: list, moved: false, relinked: 0, unlinked: 0 };
  }
  const sec = source.sections.find((s) => s.id === sectionId);
  const sourceAfter = { ...source, sections: source.sections.filter((s) => s.id !== sectionId) };
  const targetSections = target.sections ? target.sections.slice() : [];
  targetSections.splice(insertAt(targetSections, position), 0, sec);
  const targetAfter = { ...target, sections: targetSections };
  let next = list.map((p) => (p.id === source.id ? sourceAfter : p.id === target.id ? targetAfter : p));
  const fix = relinkSourcePage(source, sourceAfter, sectionId, targetAfter, next);
  if (fix.page !== sourceAfter) next = next.map((p) => (p.id === source.id ? fix.page : p));
  return { pages: next, moved: true, relinked: fix.relinked, unlinked: fix.unlinked };
}

// Copy a section onto another page (or the same page) with fresh ids.
// Returns { pages, copied, newId }.
export function copySectionToPage(pages, sectionId, targetPageId, position = 'bottom', makeId = newSectionId) {
  const list = Array.isArray(pages) ? pages : [];
  const source = findSectionPage(list, sectionId);
  const target = list.find((p) => p.id === targetPageId);
  if (!source || !target) return { pages: list, copied: false, newId: null };
  const clone = cloneSection(source.sections.find((s) => s.id === sectionId), makeId);
  const targetSections = target.sections ? target.sections.slice() : [];
  targetSections.splice(insertAt(targetSections, position), 0, clone);
  return {
    pages: list.map((p) => (p.id === target.id ? { ...target, sections: targetSections } : p)),
    copied: true,
    newId: clone.id,
  };
}

// Move a section to an exact index on its own page (drag reorder).
export function moveSectionWithinPage(sections, sectionId, targetIndex) {
  const i = sections.findIndex((s) => s.id === sectionId);
  if (i < 0) return sections;
  const next = sections.slice();
  const [item] = next.splice(i, 1);
  const clamped = Math.max(0, Math.min(next.length, targetIndex));
  if (clamped === i) return sections;
  next.splice(clamped, 0, item);
  return next;
}

// Drag math shared by the canvas and the outline: given the insertion gap
// (0..n, "drop before item gap") and the dragged item's current index,
// return the index to pass to moveSectionWithinPage, or null for no move.
export function dropGapToIndex(gap, srcIdx) {
  if (gap == null || srcIdx < 0) return null;
  const idx = srcIdx < gap ? gap - 1 : gap;
  return idx === srcIdx ? null : idx;
}

// A slug for a new page that the server accepts (lowercase letters, digits
// and inner hyphens, at most 40 characters) and no other page uses.
export function uniquePageSlug(title, pages, selfId = null) {
  // `selfId`: the page being renamed, so its own address does not count as
  // taken. Accents are folded ("Café" -> "cafe"); a name with no letters or
  // digits (an emoji, another alphabet) falls back to "page".
  const used = new Set((pages || []).filter((p) => p && p.id !== selfId).map((p) => p.slug || ''));
  const base = String(title || '').toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 34).replace(/-+$/g, '') || 'page';
  let slug = base;
  let n = 2;
  while (used.has(slug)) slug = `${base}-${n++}`;
  return slug;
}
