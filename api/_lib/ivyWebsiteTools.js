// Ivy's website tools: build, edit and publish the owner's public site.
//
// The site is the same data the Website → Editor works on (websites.pages,
// one home page at slug '' plus sub-pages). Ivy edits the DRAFT, exactly as
// the editor's autosave (PUT /api/website) does, and every page/section
// operation runs the editor's own transforms (src/features/website/
// pageTransforms.js), so a move made by Ivy and one made by dragging in the
// editor produce the same draft, anchor-link re-pointing included.
//
// Every write is approval-gated (WEBSITE_SENSITIVE). Each tool is planned in
// one place (planWebsite): the plan validates the call against the current
// draft and words the approval card ("Move 'Gallery' from Home to About
// (bottom)"); the same plan, rebuilt from the draft as it is when the owner
// taps Approve, is what runs. Nothing goes public unless the owner approves
// publish_website.
import { sql } from './db.js';
import { SECTION_TYPES, STARTER_PACKS, FONT_PAIRS, mkSection } from '../../src/features/website/sections.js';
import { TEMPLATES } from '../../src/features/website/templates.js';
import {
  moveSectionToPage, copySectionToPage, moveSectionWithinPage, cloneSection, findSectionPage, uniquePageSlug,
} from '../../src/features/website/pageTransforms.js';
import { sanitizeSiteLinks } from './siteLinkSafety.js';
import { saveWebsiteVersion, restoreWebsiteVersion } from './websiteVersions.js';
import { workspaceTimeZone } from './calendar.js';
import { appUrl } from './tokens.js';

const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const SLUG_RE = HANDLE_RE;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const slugify = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const MAX_PAGES = 50;
const MAX_SECTIONS = 40;
// Section types Ivy never adds or edits: raw HTML/code goes on the public
// site as is, so only the owner places it, by hand, in the editor.
const OWNER_ONLY_TYPES = new Set(['custom_html', 'code_snippet']);

const SECTION_ACTIONS = ['update', 'add', 'remove', 'hide', 'show', 'move', 'duplicate', 'move_to_page', 'copy_to_page'];
const PAGE_ACTIONS = ['add', 'rename', 'remove', 'move', 'show_in_nav', 'hide_from_nav'];

// ── tool definitions (compact: sent with every request) ───────────────
export const WEBSITE_TOOLS = [
  {
    name: 'get_website',
    description: "Read the owner's website draft: handle, public URL, published or not, unpublished changes, scheduled publish, every page (slug, title) with its sections (ids, types, headlines), saved versions, and the template packs, looks, font pairs and section types available. Call before any website change.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'create_website',
    description: "Build the website from a template pack (full multi-page site in their business name). Replaces the current draft. Packs: service_pro, creative_studio, coach_consultant, studio_team, premium_minimal, writer_speaker.",
    input_schema: {
      type: 'object',
      properties: {
        template_pack: { type: 'string' },
        business_name: { type: 'string' },
        handle:        { type: 'string', description: 'Optional URL handle (lowercase, digits, hyphens).' },
      },
      required: ['template_pack', 'business_name'],
    },
  },
  {
    name: 'edit_website_section',
    description: "Change sections on the website draft, same as the editor: update (text/fields in `data`, layout `variant`), add (`type`), remove, hide, show, move (reorder on its page), duplicate, move_to_page / copy_to_page (to `target_page`, or to a new page named `new_page_title`; buttons that pointed at a moved section are re-pointed). Ids from get_website.",
    input_schema: {
      type: 'object',
      properties: {
        action:         { type: 'string', enum: SECTION_ACTIONS },
        page_slug:      { type: 'string', description: "Page of the section ('' = home). Needed for add." },
        section_id:     { type: 'string' },
        type:           { type: 'string', description: 'Section type for add.' },
        data:           { type: 'object', description: 'Fields to set, e.g. {"headline":"...","cta":"Book now"}. Only fields of that section type.' },
        variant:        { type: 'string' },
        position:       { description: "Zero-based index, or 'top' / 'bottom' (default bottom)." },
        target_page:    { type: 'string', description: 'Slug of the page to move/copy to.' },
        new_page_title: { type: 'string', description: 'Move/copy to a new page with this title.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'edit_website_page',
    description: "Pages on the website draft: add (with optional section_types), rename (title, new_slug, meta_title, meta_description), remove, move (menu order, `position`), show_in_nav, hide_from_nav. The home page (slug '') cannot be removed or re-slugged.",
    input_schema: {
      type: 'object',
      properties: {
        action:           { type: 'string', enum: PAGE_ACTIONS },
        slug:             { type: 'string', description: "The page ('' = home); for add, the new slug (optional, made from the title)." },
        title:            { type: 'string' },
        new_slug:         { type: 'string' },
        meta_title:       { type: 'string' },
        meta_description: { type: 'string' },
        section_types:    { type: 'array', items: { type: 'string' } },
        position:         { description: "Zero-based index, or 'top' / 'bottom'." },
      },
      required: ['action', 'slug'],
    },
  },
  {
    name: 'update_website',
    description: 'Site-wide settings: business name on the site, template look, font pair, SEO title and description. These show on the live site right away (no publish needed).',
    input_schema: {
      type: 'object',
      properties: {
        business_name: { type: 'string' }, template: { type: 'string' }, font_pair: { type: 'string' },
        seo_title: { type: 'string' }, seo_description: { type: 'string' },
      },
    },
  },
  {
    name: 'publish_website',
    description: 'Make the draft live now, or schedule it with `at` (ISO date-time with offset), or cancel_schedule: true. Needs a handle.',
    input_schema: {
      type: 'object',
      properties: { at: { type: 'string' }, cancel_schedule: { type: 'boolean' } },
    },
  },
  {
    name: 'restore_website',
    description: 'discard_draft: throw away draft changes since the last publish (back to what is live). restore_version: put a saved version (version_id from get_website) back into the draft.',
    input_schema: {
      type: 'object',
      properties: {
        action:     { type: 'string', enum: ['discard_draft', 'restore_version'] },
        version_id: { type: 'string' },
      },
      required: ['action'],
    },
  },
];

export const WEBSITE_TOOL_NAMES = new Set(WEBSITE_TOOLS.map((t) => t.name));
// Every website write waits for the owner's Approve.
export const WEBSITE_SENSITIVE = WEBSITE_TOOLS.map((t) => t.name).filter((n) => n !== 'get_website');

// ── helpers ────────────────────────────────────────────────────────────
async function loadSite(workspaceId) {
  const r = await sql`SELECT * FROM websites WHERE workspace_id = ${workspaceId}`;
  if (r.rows.length) return r.rows[0];
  const ins = await sql`INSERT INTO websites (workspace_id) VALUES (${workspaceId}) ON CONFLICT (workspace_id) DO NOTHING RETURNING *`;
  if (ins.rows.length) return ins.rows[0];
  return (await sql`SELECT * FROM websites WHERE workspace_id = ${workspaceId}`).rows[0];
}

// The draft pages, deep-copied (plans may mutate freely) with an id on
// every page (the transforms address pages by id).
function pagesOf(row) {
  const raw = Array.isArray(row.pages) && row.pages.length
    ? row.pages
    // Legacy single-page site: the sections column is the home page.
    : [{ id: 'home', slug: '', title: 'Home', sections: Array.isArray(row.sections) ? row.sections : [], inNav: true }];
  return JSON.parse(JSON.stringify(raw)).map((p, i) => ({
    ...p,
    id: p.id || `pg_${i}_${p.slug || 'home'}`,
    slug: p.slug || '',
    sections: Array.isArray(p.sections) ? p.sections : [],
  }));
}

// Same write the editor's autosave makes: pages plus the legacy home mirror,
// with the same link sanitising as PUT /api/website.
async function savePages(workspaceId, pages) {
  const clean = sanitizeSiteLinks(pages);
  const home = clean.find((p) => (p.slug || '') === '') || clean[0];
  await sql`
    UPDATE websites SET
      pages = ${JSON.stringify(clean)}::jsonb,
      sections = ${JSON.stringify(home?.sections || [])}::jsonb,
      updated_at = NOW()
    WHERE workspace_id = ${workspaceId}
  `;
  return clean;
}

const clip = (s, n = 60) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const typeLabel = (t) => SECTION_TYPES[t]?.label || String(t || 'section');
function sectionName(s) {
  const d = s?.data || {};
  const h = [d.headline, d.title].find((x) => typeof x === 'string' && x.trim());
  return `'${typeLabel(s?.type)}'${h ? ` ("${clip(h, 40)}")` : ''}`;
}
const pageName = (p) => clip(p?.title || (p?.slug ? p.slug : 'Home'), 40);
const normSlug = (v) => String(v ?? '').toLowerCase().trim().replace(/^\/+|\/+$/g, '');

function parsePosition(v, dflt = 'bottom') {
  if (v === undefined || v === null || v === '') return dflt;
  if (v === 'top' || v === 'bottom') return v;
  const n = typeof v === 'number' ? v : (/^\d+$/.test(String(v).trim()) ? Number(v) : NaN);
  if (!Number.isFinite(n) || n < 0) throw new Error("position must be a zero-based number, 'top' or 'bottom'");
  return Math.floor(n);
}
const posWords = (pos) => (pos === 'top' ? 'top' : pos === 'bottom' ? 'bottom' : `position ${pos + 1}`);
const indexFor = (pos, len) => (pos === 'top' ? 0 : pos === 'bottom' ? len : Math.min(pos, len));

function noPage(slug, pages) {
  return new Error(`No page with slug "${slug}". Pages: ${pages.map((p) => `'${p.slug || ''}'`).join(', ')}`);
}

function sectionSummary(s) {
  const d = s.data || {};
  const out = { id: s.id, type: s.type, variant: s.variant || null, visible: s.visible !== false };
  for (const k of ['headline', 'sub', 'cta', 'ctaLink', 'body', 'title']) if (typeof d[k] === 'string' && d[k]) out[k] = d[k].slice(0, 160);
  if (Array.isArray(d.items)) out.items = d.items.length;
  if (Array.isArray(d.images)) out.images = d.images.length;
  return out;
}

function siteUrl(row) {
  if (row.custom_domain && row.domain_status === 'verified') return `https://${row.custom_domain}`;
  return row.handle ? `${appUrl()}/site/${row.handle}` : null;
}

function hasUnpublished(row) {
  const stable = (v) => JSON.stringify(v ?? null);
  return !!row.published_at && (
    stable(row.sections) !== stable(row.published_sections ?? row.sections)
    || stable(row.pages) !== stable(row.published_pages ?? row.pages));
}

function outline(row) {
  const pages = pagesOf(row);
  return {
    exists: !!(row.handle || pages.some((p) => p.sections.length)),
    handle: row.handle || null,
    businessName: row.business_name || null,
    template: row.template,
    fontPair: row.font_pair || null,
    launched: !!row.launched,
    publishedAt: row.published_at || null,
    hasUnpublishedChanges: hasUnpublished(row),
    scheduledPublishAt: row.scheduled_publish_at || null,
    url: siteUrl(row),
    editorUrl: '/website',
    pages: pages.map((p) => ({ slug: p.slug, title: p.title, inNav: p.inNav !== false, sections: p.sections.map(sectionSummary) })),
  };
}

function fmtWhen(d, tz) {
  try {
    return new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: tz || 'UTC' });
  } catch { return new Date(d).toISOString(); }
}

const TEMPLATE_PACKS = Object.values(STARTER_PACKS).map((p) => ({ id: p.id, label: p.label, description: p.desc }));
const SECTION_CATALOG = Object.entries(SECTION_TYPES).filter(([type]) => !OWNER_ONLY_TYPES.has(type)).map(([type, cfg]) => ({
  type, label: cfg.label, description: cfg.desc,
  variants: (cfg.variants || []).map((v) => v.id),
  fields: Object.keys(typeof cfg.default === 'function' ? cfg.default('') : {}),
}));

// Merge owner-facing fields into section.data. Keys must already exist on
// the section (its type's defaults), so Ivy cannot invent fields the
// renderer ignores. Strings are capped; arrays and objects pass through.
// Returns the keys that were set.
function mergeData(section, data) {
  const defaults = typeof SECTION_TYPES[section.type]?.default === 'function' ? SECTION_TYPES[section.type].default('') : {};
  section.data = section.data && typeof section.data === 'object' ? section.data : {};
  const set = [];
  for (const [k, v] of Object.entries(data)) {
    if (!(k in defaults) && !(k in section.data)) continue;
    if (typeof v === 'string') section.data[k] = v.slice(0, 4000);
    else if (typeof v === 'number' || typeof v === 'boolean' || v === null) section.data[k] = v;
    else if (Array.isArray(v)) section.data[k] = v.slice(0, 60);
    else if (typeof v === 'object') section.data[k] = v;
    else continue;
    set.push(k);
  }
  return set;
}

function describeFieldChanges(section, keys) {
  return keys.slice(0, 6).map((k) => {
    const v = section.data[k];
    if (typeof v === 'string') return `${k} to "${clip(v, 60)}"`;
    if (Array.isArray(v)) return `${k} (${v.length} item${v.length === 1 ? '' : 's'})`;
    return k;
  }).join(', ') + (keys.length > 6 ? ` and ${keys.length - 6} more` : '');
}

// ── plans ─────────────────────────────────────────────────────────────
// Each plan validates against the draft (throwing a plain-English Error for
// a call that cannot work), and returns:
//   summary  what the approval card says (imperative)
//   done     the past-tense line for the chat ledger
//   apply()  performs it; returns the tool result
function planSectionEdit(row, workspaceId, a) {
  const pages = pagesOf(row);
  const action = String(a.action || '');
  if (!SECTION_ACTIONS.includes(action)) throw new Error(`action must be one of: ${SECTION_ACTIONS.join(', ')}`);
  const biz = row.business_name || '';
  const save = (next, extra = {}) => async () => {
    const saved = await savePages(workspaceId, next);
    return { ok: true, ...extra, pages: saved.map((p) => ({ slug: p.slug || '', title: p.title, sections: (p.sections || []).map(sectionSummary) })) };
  };

  if (action === 'add') {
    const slug = normSlug(a.page_slug);
    const page = pages.find((p) => p.slug === slug);
    if (!page) throw noPage(slug, pages);
    const type = String(a.type || '');
    if (OWNER_ONLY_TYPES.has(type)) throw new Error(`${typeLabel(type)} sections can only be added by the owner in the Website editor.`);
    if (!SECTION_TYPES[type]) throw new Error(`Unknown section type "${type}"`);
    if (page.sections.length >= MAX_SECTIONS) throw new Error(`A page can hold up to ${MAX_SECTIONS} sections`);
    const pos = parsePosition(a.position);
    const s = mkSection(type, biz);
    if (a.variant && (SECTION_TYPES[type].variants || []).some((v) => v.id === a.variant)) s.variant = a.variant;
    if (a.data && typeof a.data === 'object') mergeData(s, a.data);
    page.sections.splice(indexFor(pos, page.sections.length), 0, s);
    const where = `${pageName(page)} (${posWords(pos)})`;
    return {
      summary: `Add a ${sectionName(s)} section to ${where}`,
      done: `Website draft: added a ${sectionName(s)} section to ${where}`,
      apply: save(pages, { added: sectionSummary(s), page: slug }),
    };
  }

  const sid = String(a.section_id || '');
  if (!sid) throw new Error('section_id is required (get it from get_website)');
  const page = findSectionPage(pages, sid);
  if (!page) throw new Error(`No section with id "${sid}" on this website. Call get_website for ids.`);
  const idx = page.sections.findIndex((s) => s.id === sid);
  const s = page.sections[idx];
  const name = sectionName(s);
  const on = pageName(page);
  if (OWNER_ONLY_TYPES.has(s.type) && (action === 'update' || action === 'duplicate' || action === 'copy_to_page')) {
    throw new Error(`${typeLabel(s.type)} sections can only be edited by the owner in the Website editor.`);
  }

  if (action === 'update') {
    const parts = [];
    if (a.variant) {
      const v = (SECTION_TYPES[s.type]?.variants || []).find((x) => x.id === a.variant);
      if (!v) throw new Error(`"${a.variant}" is not a layout of ${s.type}. Layouts: ${(SECTION_TYPES[s.type]?.variants || []).map((x) => x.id).join(', ') || 'none'}`);
      s.variant = v.id;
      parts.push(`layout to ${v.label || v.id}`);
    }
    if (a.data && typeof a.data === 'object' && !Array.isArray(a.data)) {
      const keys = mergeData(s, a.data);
      if (!keys.length && !parts.length) {
        const fields = Object.keys(SECTION_TYPES[s.type]?.default?.('') || {});
        throw new Error(`None of those fields exist on a ${s.type} section. Fields: ${fields.join(', ')}`);
      }
      if (keys.length) parts.push(describeFieldChanges(s, keys));
    }
    if (!parts.length) throw new Error('Nothing to change: pass data and/or variant');
    return {
      summary: `Change the ${name} section on ${on}: ${parts.join('; ')}`,
      done: `Website draft: changed the ${name} section on ${on}`,
      apply: save(pages),
    };
  }
  if (action === 'remove') {
    page.sections.splice(idx, 1);
    return { summary: `Remove the ${name} section from ${on}`, done: `Website draft: removed the ${name} section from ${on}`, apply: save(pages) };
  }
  if (action === 'hide' || action === 'show') {
    const hide = action === 'hide';
    if ((s.visible !== false) === !hide) throw new Error(`That section is already ${hide ? 'hidden' : 'showing'}`);
    s.visible = !hide;
    return {
      summary: hide ? `Hide the ${name} section on ${on} (it stays in the draft, visitors won't see it)` : `Show the ${name} section on ${on} again`,
      done: `Website draft: ${hide ? 'hid' : 'showed'} the ${name} section on ${on}`,
      apply: save(pages),
    };
  }
  if (action === 'duplicate') {
    if (page.sections.length >= MAX_SECTIONS) throw new Error(`A page can hold up to ${MAX_SECTIONS} sections`);
    const copy = cloneSection(s);
    page.sections.splice(idx + 1, 0, copy);
    return {
      summary: `Duplicate the ${name} section on ${on} (the copy goes right below it)`,
      done: `Website draft: duplicated the ${name} section on ${on}`,
      apply: save(pages, { newSectionId: copy.id }),
    };
  }
  if (action === 'move') {
    if (a.position === undefined || a.position === null || a.position === '') throw new Error('position is required for move');
    const pos = parsePosition(a.position);
    const target = pos === 'top' ? 0 : pos === 'bottom' ? page.sections.length - 1 : Math.min(pos, page.sections.length - 1);
    const next = moveSectionWithinPage(page.sections, sid, target);
    if (next === page.sections) throw new Error(`The ${name} section is already at that spot on ${on}`);
    page.sections = next;
    const words = `${posWords(pos === 'top' || pos === 'bottom' ? pos : target)} of ${next.length}`;
    return {
      summary: `Move the ${name} section on ${on} to ${words}`,
      done: `Website draft: moved the ${name} section on ${on} to ${words}`,
      apply: save(pages),
    };
  }

  // move_to_page / copy_to_page: same transforms as the editor's "Move to
  // page" / "Copy to page" menu, including a brand-new target page.
  const pos = parsePosition(a.position);
  let list = pages;
  let targetPage;
  let newPage = false;
  if (a.new_page_title && String(a.new_page_title).trim()) {
    if (pages.length >= MAX_PAGES) throw new Error(`Up to ${MAX_PAGES} pages per site`);
    const title = String(a.new_page_title).trim().slice(0, 120);
    targetPage = { id: `pg_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6)}`, slug: uniquePageSlug(title, pages), title, sections: [], inNav: true };
    list = [...pages, targetPage];
    newPage = true;
  } else {
    if (a.target_page === undefined || a.target_page === null) throw new Error('target_page (a page slug) or new_page_title is required');
    const tslug = normSlug(a.target_page);
    targetPage = pages.find((p) => p.slug === tslug);
    if (!targetPage) throw noPage(tslug, pages);
  }
  if ((targetPage.sections || []).length >= MAX_SECTIONS) throw new Error(`A page can hold up to ${MAX_SECTIONS} sections`);
  const to = `${pageName(targetPage)}${newPage ? ` (a new page at /${targetPage.slug})` : ''} (${posWords(pos)})`;
  if (action === 'move_to_page') {
    if (targetPage.id === page.id) throw new Error(`That section is already on ${on}; use action "move" to reorder it`);
    const r = moveSectionToPage(list, sid, targetPage.id, pos);
    if (!r.moved) throw new Error('That section could not be moved');
    let note = '';
    if (r.relinked) note += `. ${r.relinked} button${r.relinked === 1 ? '' : 's'} on ${on} that pointed to it will open the ${pageName(targetPage)} page instead`;
    if (r.unlinked) note += `. ${r.unlinked} button${r.unlinked === 1 ? '' : 's'} on ${on} that pointed to it will no longer find it`;
    return {
      summary: `Move ${name} from ${on} to ${to}${note}`,
      done: `Website draft: moved ${name} from ${on} to ${pageName(targetPage)}`,
      apply: save(r.pages, { relinked: r.relinked, unlinked: r.unlinked }),
    };
  }
  const r = copySectionToPage(list, sid, targetPage.id, pos);
  if (!r.copied) throw new Error('That section could not be copied');
  return {
    summary: `Copy ${name} from ${on} to ${to}`,
    done: `Website draft: copied ${name} from ${on} to ${pageName(targetPage)}`,
    apply: save(r.pages, { newSectionId: r.newId }),
  };
}

function planPageEdit(row, workspaceId, a) {
  const pages = pagesOf(row);
  const action = String(a.action || '');
  if (!PAGE_ACTIONS.includes(action)) throw new Error(`action must be one of: ${PAGE_ACTIONS.join(', ')}`);
  const slug = normSlug(a.slug);
  const save = (next, extra = {}) => async () => {
    const saved = await savePages(workspaceId, next);
    return { ok: true, ...extra, pages: saved.map((p) => ({ slug: p.slug || '', title: p.title, inNav: p.inNav !== false })) };
  };

  if (action === 'add') {
    if (pages.length >= MAX_PAGES) throw new Error(`Up to ${MAX_PAGES} pages per site`);
    const title = String(a.title || slug || '').trim().slice(0, 120);
    if (!title) throw new Error('title is required');
    const newSlug = slug || uniquePageSlug(title, pages);
    if (!SLUG_RE.test(newSlug)) throw new Error('slug must be lowercase letters, digits and hyphens');
    if (pages.some((p) => p.slug === newSlug)) throw new Error(`A page with slug "${newSlug}" already exists`);
    const types = Array.isArray(a.section_types) && a.section_types.length ? a.section_types.slice(0, MAX_SECTIONS).map(String) : ['hero', 'footer'];
    const bad = types.find((t) => !SECTION_TYPES[t] || OWNER_ONLY_TYPES.has(t));
    if (bad) throw new Error(`Unknown section type "${bad}"`);
    const page = {
      id: `pg_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6)}`, slug: newSlug, title, inNav: true,
      sections: types.map((t) => mkSection(t, row.business_name || '')),
    };
    if (page.sections[0]?.type === 'hero') page.sections[0].data.headline = title;
    let at = pages.length;
    if (a.position !== undefined && a.position !== null && a.position !== '') at = indexFor(parsePosition(a.position), pages.length);
    pages.splice(Math.max(1, at), 0, page);
    const kinds = types.map(typeLabel).join(', ');
    return {
      summary: `Add a new page "${title}" at /${newSlug} with these sections: ${kinds}`,
      done: `Website draft: added the page "${title}" (/${newSlug})`,
      apply: save(pages, { page: { slug: newSlug, title, sections: page.sections.map(sectionSummary) } }),
    };
  }

  const page = pages.find((p) => p.slug === slug);
  if (!page) throw noPage(slug, pages);
  const nm = pageName(page);
  if (action === 'rename') {
    const parts = [];
    if (a.title != null && String(a.title).trim()) {
      const title = String(a.title).trim().slice(0, 120);
      if (title !== page.title) { parts.push(`rename it to "${title}"`); page.title = title; }
    }
    if (a.new_slug != null && normSlug(a.new_slug) !== slug) {
      if (slug === '') throw new Error("The home page's address cannot change");
      const ns = normSlug(a.new_slug);
      if (!SLUG_RE.test(ns)) throw new Error('new_slug must be lowercase letters, digits and hyphens');
      if (pages.some((p) => p.slug === ns)) throw new Error(`A page with slug "${ns}" already exists`);
      parts.push(`change its address from /${slug} to /${ns} (links to the old address stop working)`);
      page.slug = ns;
    }
    if (a.meta_title != null) { page.metaTitle = String(a.meta_title).slice(0, 200); parts.push(`set its search title to "${clip(page.metaTitle, 60)}"`); }
    if (a.meta_description != null) { page.metaDescription = String(a.meta_description).slice(0, 400); parts.push(`set its search description to "${clip(page.metaDescription, 80)}"`); }
    if (!parts.length) throw new Error('Nothing to change: pass title, new_slug, meta_title or meta_description');
    return {
      summary: `On the ${nm} page: ${parts.join('; ')}`,
      done: `Website draft: updated the ${nm} page`,
      apply: save(pages),
    };
  }
  if (action === 'remove') {
    if (slug === '') throw new Error('The home page cannot be removed');
    pages.splice(pages.indexOf(page), 1);
    const n = page.sections.length;
    return {
      summary: `Remove the ${nm} page (/${slug}) and its ${n} section${n === 1 ? '' : 's'} from the draft`,
      done: `Website draft: removed the ${nm} page`,
      apply: save(pages),
    };
  }
  if (action === 'move') {
    if (a.position === undefined || a.position === null || a.position === '') throw new Error('position is required for move');
    const pos = parsePosition(a.position);
    const from = pages.indexOf(page);
    pages.splice(from, 1);
    const at = indexFor(pos, pages.length);
    if (at === from) throw new Error(`The ${nm} page is already there`);
    pages.splice(at, 0, page);
    return {
      summary: `Move the ${nm} page to position ${at + 1} of ${pages.length} in the menu`,
      done: `Website draft: moved the ${nm} page to position ${at + 1} in the menu`,
      apply: save(pages),
    };
  }
  // show_in_nav / hide_from_nav
  const show = action === 'show_in_nav';
  if ((page.inNav !== false) === show) throw new Error(`The ${nm} page is already ${show ? 'in' : 'hidden from'} the menu`);
  page.inNav = show;
  return {
    summary: show ? `Show the ${nm} page in the site menu` : `Hide the ${nm} page from the site menu (the page still exists at /${slug})`,
    done: `Website draft: ${show ? 'added' : 'hid'} the ${nm} page ${show ? 'to' : 'from'} the menu`,
    apply: save(pages),
  };
}

function planUpdate(row, workspaceId, a) {
  const parts = [];
  const patch = {};
  if ('business_name' in a && a.business_name != null) {
    const v = String(a.business_name).trim().slice(0, 120);
    if (!v) throw new Error('business_name cannot be empty');
    if (v !== row.business_name) { patch.biz = v; parts.push(`business name to "${clip(v, 60)}"`); }
  }
  if (a.template) {
    const t = TEMPLATES[String(a.template)];
    if (!t) throw new Error(`Unknown template look "${a.template}". Looks: ${Object.keys(TEMPLATES).join(', ')}`);
    if (t.id !== row.template) { patch.tpl = t.id; parts.push(`look to ${t.name}`); }
  }
  if ('font_pair' in a) {
    const f = a.font_pair ? String(a.font_pair) : null;
    if (f && !FONT_PAIRS[f]) throw new Error(`Unknown font pair "${f}". Font pairs: ${Object.keys(FONT_PAIRS).join(', ')}`);
    if (f !== (row.font_pair || null)) { patch.font = f; parts.push(f ? `fonts to ${FONT_PAIRS[f].label.split(' (')[0]}` : "fonts back to the look's own"); }
  }
  if ('seo_title' in a && a.seo_title != null) { patch.seoT = String(a.seo_title).slice(0, 200); parts.push(`search title to "${clip(patch.seoT, 60)}"`); }
  if ('seo_description' in a && a.seo_description != null) { patch.seoD = String(a.seo_description).slice(0, 400); parts.push(`search description to "${clip(patch.seoD, 80)}"`); }
  if (!parts.length) throw new Error('Nothing to change: pass business_name, template, font_pair, seo_title or seo_description with a new value');
  return {
    summary: `Change the website ${parts.join('; ')}. These settings show on the live site right away.`,
    done: `Website: changed the ${parts.map((p) => p.split(' to ')[0]).join(', ')}`,
    apply: async () => {
      await sql`
        UPDATE websites SET
          business_name   = COALESCE(${patch.biz ?? null}, business_name),
          template        = COALESCE(${patch.tpl ?? null}, template),
          seo_title       = COALESCE(${patch.seoT ?? null}, seo_title),
          seo_description = COALESCE(${patch.seoD ?? null}, seo_description),
          font_pair       = CASE WHEN ${'font' in patch} THEN ${patch.font ?? null} ELSE font_pair END,
          updated_at      = NOW()
        WHERE workspace_id = ${workspaceId}
      `;
      return { ok: true, website: outline(await loadSite(workspaceId)) };
    },
  };
}

async function planPublish(row, workspaceId, a, ctx) {
  if (!row.handle) throw new Error('The site needs a handle before it can be published (build it with create_website, or set one in Website, Settings)');
  const tz = await workspaceTimeZone(workspaceId).catch(() => 'UTC');
  if (a.cancel_schedule === true) {
    if (!row.scheduled_publish_at) throw new Error('There is no scheduled publish to cancel');
    const when = fmtWhen(row.scheduled_publish_at, tz);
    return {
      summary: `Cancel the scheduled website publish (${when}). The live site stays as it is.`,
      done: 'Cancelled the scheduled website publish',
      apply: async () => {
        await sql`UPDATE websites SET scheduled_publish_at = NULL, scheduled_pages = NULL, updated_at = NOW() WHERE workspace_id = ${workspaceId}`;
        return { ok: true, scheduledPublishAt: null };
      },
    };
  }
  if (a.at) {
    const at = new Date(String(a.at));
    if (Number.isNaN(at.getTime())) throw new Error('at must be an ISO date and time, e.g. 2026-11-20T09:00:00-05:00');
    const now = Date.now();
    if (at.getTime() < now + 60_000) throw new Error('at must be in the future');
    if (at.getTime() > now + 366 * 86400_000) throw new Error('at must be within the next year');
    const when = fmtWhen(at, tz);
    return {
      summary: `Schedule the website draft as it is now to go live on ${when} (${tz}). Edits made after this wait for the next publish.`,
      done: `Scheduled the website to go live on ${when}`,
      apply: async () => {
        // Same as the editor's schedule: freeze the draft pages now; the
        // scheduled-publish cron promotes them at that time.
        const pages = sanitizeSiteLinks(pagesOf(row));
        await sql`
          UPDATE websites SET scheduled_publish_at = ${at.toISOString()}::timestamptz,
                 scheduled_pages = ${JSON.stringify(pages)}::jsonb, updated_at = NOW()
           WHERE workspace_id = ${workspaceId}`;
        return { ok: true, scheduledPublishAt: at.toISOString() };
      },
    };
  }
  const url = siteUrl(row);
  return {
    summary: `Publish the website draft so it is live${url ? ` at ${url}` : ''}`,
    done: `Published your website${url ? ` at ${url}` : ''}`,
    apply: async () => {
      const fresh = await loadSite(workspaceId);
      await saveWebsiteVersion(fresh, ctx?.userId || null);
      const upd = await sql`
        UPDATE websites SET launched = TRUE, published_at = NOW(), published_sections = sections, published_pages = pages, updated_at = NOW()
        WHERE workspace_id = ${workspaceId} RETURNING *
      `;
      return { ok: true, url: siteUrl(upd.rows[0]), publishedAt: upd.rows[0].published_at };
    },
  };
}

async function planRestore(row, workspaceId, a, ctx) {
  const tz = await workspaceTimeZone(workspaceId).catch(() => 'UTC');
  if (a.action === 'discard_draft') {
    if (!row.published_at) throw new Error('The site has not been published yet, so there is no published version to go back to');
    if (!hasUnpublished(row)) throw new Error('There are no unpublished changes to throw away');
    return {
      summary: `Throw away every website draft change since you last published (${fmtWhen(row.published_at, tz)}) and go back to what is live now. The live site does not change.`,
      done: 'Website draft: threw away the unpublished changes',
      apply: async () => {
        await sql`
          UPDATE websites SET sections = COALESCE(published_sections, sections), pages = COALESCE(published_pages, pages), updated_at = NOW()
           WHERE workspace_id = ${workspaceId} AND published_at IS NOT NULL`;
        return { ok: true, discarded: true };
      },
    };
  }
  if (a.action === 'restore_version') {
    const vid = String(a.version_id || '');
    if (!UUID_RE.test(vid)) throw new Error('version_id is required (from get_website versions)');
    const v = (await sql`SELECT id, created_at, snapshot FROM website_versions WHERE id = ${vid} AND website_id = ${row.id}`).rows[0];
    if (!v) throw new Error('That version was not found on this website');
    const n = Array.isArray(v.snapshot?.pages) ? v.snapshot.pages.length : 0;
    return {
      summary: `Put back the website version saved ${fmtWhen(v.created_at, tz)}${n ? ` (${n} page${n === 1 ? '' : 's'})` : ''}: its pages and sections go into your draft (publish to make them live), and its look, fonts and SEO settings apply to the live site right away. Your current version is saved first so you can go back.`,
      done: `Website: put back the version saved ${fmtWhen(v.created_at, tz)}`,
      apply: async () => {
        const fresh = await loadSite(workspaceId);
        await restoreWebsiteVersion(fresh, v.snapshot, ctx?.userId || null);
        return { ok: true, restored: true };
      },
    };
  }
  throw new Error('action must be discard_draft or restore_version');
}

function planCreate(row, workspaceId, a) {
  const pack = STARTER_PACKS[String(a.template_pack || '')];
  if (!pack) throw new Error(`Unknown template_pack. Use one of: ${Object.keys(STARTER_PACKS).join(', ')}`);
  const biz = String(a.business_name || '').trim().slice(0, 120);
  if (!biz) throw new Error('business_name is required');
  const handle = (a.handle ? String(a.handle).toLowerCase().trim() : slugify(biz)) || null;
  if (!handle || !HANDLE_RE.test(handle)) throw new Error('A valid handle is needed (lowercase letters, digits, hyphens)');
  return {
    summary: `Build the website from the "${pack.label}" template for ${biz} at /site/${handle}. This replaces the current website draft (nothing goes public until it is published).`,
    done: `Built your website draft from the "${pack.label}" template`,
    apply: async () => {
      const clash = await sql`SELECT id FROM websites WHERE handle = ${handle} AND workspace_id <> ${workspaceId}`;
      if (clash.rows.length) throw new Error(`The handle "${handle}" is taken; pick another`);
      const pages = sanitizeSiteLinks(pack.build(biz));
      await sql`
        UPDATE websites SET
          business_name = ${biz}, handle = ${handle}, template = ${pack.template || 'clean'},
          font_pair = ${pack.fontPair || null},
          pages = ${JSON.stringify(pages)}::jsonb,
          sections = ${JSON.stringify(pages[0]?.sections || [])}::jsonb,
          updated_at = NOW()
        WHERE workspace_id = ${workspaceId}
      `;
      return { ok: true, website: outline(await loadSite(workspaceId)), next: 'The draft is built. Tailor the copy with edit_website_section, tell the owner to proof it in Website, Editor, then publish_website once they approve.' };
    },
  };
}

// The single entry point for every website write. Loads the draft fresh.
export async function planWebsite(name, args, ctx) {
  const workspaceId = ctx?.workspaceId;
  if (!workspaceId) throw new Error('No workspace');
  const a = args && typeof args === 'object' ? args : {};
  const row = await loadSite(workspaceId);
  switch (name) {
    case 'create_website': return planCreate(row, workspaceId, a);
    case 'edit_website_section': return planSectionEdit(row, workspaceId, a);
    case 'edit_website_page': return planPageEdit(row, workspaceId, a);
    case 'update_website': return planUpdate(row, workspaceId, a);
    case 'publish_website': return planPublish(row, workspaceId, a, ctx);
    case 'restore_website': return planRestore(row, workspaceId, a, ctx);
    default: return null;
  }
}

// Approval-card text. null when `name` is not a website tool.
export async function describeWebsiteAction(name, a, ctx) {
  if (!WEBSITE_SENSITIVE.includes(name)) return null;
  const plan = await planWebsite(name, a, ctx);
  return plan?.summary || null;
}

// A website call that cannot work is refused before a card is shown.
export async function refuseWebsiteAction(name, a, ctx) {
  if (!WEBSITE_SENSITIVE.includes(name)) return null;
  try {
    await planWebsite(name, a, ctx);
    return null;
  } catch (err) {
    return `${err?.message || 'That website change is not possible'}. Nothing was changed. If it depends on another change still waiting for approval, ask the owner to approve that first.`;
  }
}

// ── handlers ───────────────────────────────────────────────────────────
async function get_website({ workspaceId }) {
  const row = await loadSite(workspaceId);
  const tz = await workspaceTimeZone(workspaceId).catch(() => 'UTC');
  const versions = (await sql`
    SELECT id, created_at FROM website_versions WHERE website_id = ${row.id}
    ORDER BY created_at DESC LIMIT 10`).rows.map((v) => ({ id: v.id, saved: fmtWhen(v.created_at, tz) }));
  return {
    website: outline(row),
    versions,
    templatePacks: TEMPLATE_PACKS,
    looks: Object.keys(TEMPLATES),
    fontPairs: Object.keys(FONT_PAIRS),
    sectionTypes: SECTION_CATALOG,
  };
}

function writeHandler(name) {
  return async (ctx) => {
    const plan = await planWebsite(name, ctx.args, ctx);
    const result = await plan.apply();
    return { ...result, done: plan.done, summary: plan.summary };
  };
}

export const WEBSITE_HANDLERS = {
  get_website,
  ...Object.fromEntries(WEBSITE_SENSITIVE.map((n) => [n, writeHandler(n)])),
};
