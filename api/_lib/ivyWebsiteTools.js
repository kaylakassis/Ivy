// Ivy's website tools: build, edit and publish the owner's public site.
//
// The site is the same data the Website → Editor works on (websites.pages,
// one home page at slug '' plus sub-pages). Ivy edits the DRAFT; the owner
// proofs it in the editor or the preview link, and publishing (which makes
// it live) is confirmation-gated, as is replacing an existing site with a
// fresh template build.
import { sql } from './db.js';
import { SECTION_TYPES, STARTER_PACKS, mkSection } from '../../src/features/website/sections.js';
import { appUrl } from './tokens.js';

const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const SLUG_RE = HANDLE_RE;
const slugify = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

// ── tool definitions ───────────────────────────────────────────────────
export const WEBSITE_TOOLS = [
  {
    name: 'get_website',
    description: "Read the owner's website: whether one exists, its handle and public URL, whether it is published, every page with its sections (ids, types, headlines), plus the template packs and section types available. Call this first before building or editing anything on the site.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'create_website',
    description: "Build the owner's website from a template pack (a full multi-page site with real sections, in their business name). Replaces the current draft, so it is confirmation-gated. After this, use edit_website_section to tailor the copy, then publish_website when the owner is happy. Template packs: service_pro (service business), creative_studio (photographer/creative), coach_consultant, studio_team, premium_minimal, writer_speaker.",
    input_schema: {
      type: 'object',
      properties: {
        template_pack: { type: 'string', description: 'One of: service_pro, creative_studio, coach_consultant, studio_team, premium_minimal, writer_speaker.' },
        business_name: { type: 'string', description: "The owner's business name as it should appear on the site." },
        handle:        { type: 'string', description: 'Optional URL handle (lowercase letters, digits, hyphens). Defaults to a slug of the business name.' },
        confirm:       { type: 'boolean', description: 'Only true after the owner explicitly approved building (or replacing) the site.' },
      },
      required: ['template_pack', 'business_name'],
    },
  },
  {
    name: 'edit_website_section',
    description: "Change one section of a page on the owner's website draft: update its text/data, switch its layout variant, add a new section, remove, hide/show, or move one. Call get_website first to get page slugs and section ids. Changes are saved to the draft immediately (not public until publish_website).",
    input_schema: {
      type: 'object',
      properties: {
        page_slug:  { type: 'string', description: "The page: '' for the home page, otherwise the slug (e.g. 'portfolio')." },
        action:     { type: 'string', description: "'update' (merge data/variant into an existing section), 'add' (new section of `type`), 'remove', 'hide', 'show', 'move'." },
        section_id: { type: 'string', description: 'Required for update/remove/hide/show/move.' },
        type:       { type: 'string', description: "For 'add': the section type (hero, services, about, booking, testimonials, faq, gallery, contact, footer, stats, cta_banner, team, pricing, newsletter, video, logos, pricing_table, blog, instagram, countdown, hours, map, accordion, process, before_after, social_feed, shop)." },
        data:       { type: 'object', description: 'Fields to set on the section, e.g. { "headline": "...", "sub": "...", "cta": "Book now", "ctaLink": "#contact" }. Keys must exist in the section type’s data. Unknown keys are ignored.' },
        variant:    { type: 'string', description: 'A layout variant id for this section type (see get_website).' },
        position:   { type: 'integer', description: "For 'add' or 'move': zero-based index in the page (omit to append)." },
      },
      required: ['page_slug', 'action'],
    },
  },
  {
    name: 'edit_website_page',
    description: "Add, rename or remove a page on the owner's website draft, or toggle whether it appears in the nav. The home page (slug '') cannot be removed.",
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: "'add', 'rename', 'remove', 'show_in_nav', 'hide_from_nav'." },
        slug:   { type: 'string', description: "The page slug ('' = home). For 'add', the new slug (lowercase, hyphens)." },
        title:  { type: 'string', description: "For 'add' or 'rename': the page title." },
        section_types: { type: 'array', items: { type: 'string' }, description: "For 'add': section types to start the page with (defaults to hero + footer)." },
      },
      required: ['action', 'slug'],
    },
  },
  {
    name: 'update_website',
    description: "Site-level settings on the draft: business name shown on the site, template look (clean, editorial, studio, bold, minimal, warm), font pair, SEO title and description.",
    input_schema: {
      type: 'object',
      properties: {
        business_name:   { type: 'string' },
        template:        { type: 'string' },
        font_pair:       { type: 'string' },
        seo_title:       { type: 'string' },
        seo_description: { type: 'string' },
      },
    },
  },
  {
    name: 'publish_website',
    description: "Make the current draft live at the site's public URL (joinivy.ai/site/<handle>, or the owner's custom domain). Confirmation-gated: describe what will go live and get the owner's yes first. Requires a handle.",
    input_schema: {
      type: 'object',
      properties: { confirm: { type: 'boolean', description: 'Only true after the owner explicitly approved publishing.' } },
    },
  },
];

export const WEBSITE_SENSITIVE = ['create_website', 'publish_website'];

export function describeWebsiteAction(name, a) {
  if (name === 'create_website') {
    const pack = STARTER_PACKS[a.template_pack];
    return `Build the website from the "${pack?.label || a.template_pack}" template for ${a.business_name || 'the business'}${a.handle ? ` at /site/${a.handle}` : ''}. This replaces the current website draft (nothing goes public until it is published).`;
  }
  if (name === 'publish_website') return 'Publish the website draft so it is live at its public address.';
  return null;
}

// ── helpers ────────────────────────────────────────────────────────────
async function loadSite(workspaceId) {
  const r = await sql`SELECT * FROM websites WHERE workspace_id = ${workspaceId}`;
  if (r.rows.length) return r.rows[0];
  const ins = await sql`INSERT INTO websites (workspace_id) VALUES (${workspaceId}) RETURNING *`;
  return ins.rows[0];
}

function pagesOf(row) {
  const pages = Array.isArray(row.pages) ? row.pages : [];
  if (pages.length) return pages;
  // Legacy single-page site: the sections column is the home page.
  return [{ id: 'home', slug: '', title: 'Home', sections: Array.isArray(row.sections) ? row.sections : [], inNav: true }];
}

async function savePages(workspaceId, pages) {
  const home = pages.find((p) => (p.slug || '') === '') || pages[0];
  await sql`
    UPDATE websites SET
      pages = ${JSON.stringify(pages)}::jsonb,
      sections = ${JSON.stringify(home?.sections || [])}::jsonb,
      updated_at = NOW()
    WHERE workspace_id = ${workspaceId}
  `;
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

function outline(row) {
  const pages = pagesOf(row);
  return {
    exists: !!(row.handle || pages.some((p) => (p.sections || []).length)),
    handle: row.handle || null,
    businessName: row.business_name || null,
    template: row.template,
    fontPair: row.font_pair || null,
    launched: !!row.launched,
    publishedAt: row.published_at || null,
    url: siteUrl(row),
    editorUrl: `${appUrl()}/website`,
    pages: pages.map((p) => ({ slug: p.slug || '', title: p.title, inNav: p.inNav !== false, sections: (p.sections || []).map(sectionSummary) })),
  };
}

const TEMPLATE_PACKS = Object.values(STARTER_PACKS).map((p) => ({ id: p.id, label: p.label, description: p.desc }));
const SECTION_CATALOG = Object.entries(SECTION_TYPES).map(([type, cfg]) => ({
  type, label: cfg.label, description: cfg.desc,
  variants: (cfg.variants || []).map((v) => v.id),
  fields: Object.keys(typeof cfg.default === 'function' ? cfg.default('') : {}),
}));

// ── handlers ───────────────────────────────────────────────────────────
async function get_website({ workspaceId }) {
  const row = await loadSite(workspaceId);
  return { website: outline(row), templatePacks: TEMPLATE_PACKS, sectionTypes: SECTION_CATALOG };
}

async function create_website({ workspaceId, args }) {
  const pack = STARTER_PACKS[String(args?.template_pack || '')];
  if (!pack) throw new Error(`Unknown template_pack. Use one of: ${Object.keys(STARTER_PACKS).join(', ')}`);
  const biz = String(args?.business_name || '').trim().slice(0, 120);
  if (!biz) throw new Error('business_name is required');
  const handle = (args?.handle ? String(args.handle).toLowerCase().trim() : slugify(biz)) || null;
  if (!handle || !HANDLE_RE.test(handle)) throw new Error('A valid handle is needed (lowercase letters, digits, hyphens)');
  const clash = await sql`SELECT id FROM websites WHERE handle = ${handle} AND workspace_id <> ${workspaceId}`;
  if (clash.rows.length) throw new Error(`The handle "${handle}" is taken; pick another`);
  const pages = pack.build(biz);
  await loadSite(workspaceId);
  await sql`
    UPDATE websites SET
      business_name = ${biz},
      handle = ${handle},
      template = ${pack.template || 'clean'},
      font_pair = ${pack.fontPair || null},
      pages = ${JSON.stringify(pages)}::jsonb,
      sections = ${JSON.stringify(pages[0]?.sections || [])}::jsonb,
      updated_at = NOW()
    WHERE workspace_id = ${workspaceId}
  `;
  const row = await loadSite(workspaceId);
  return { ok: true, website: outline(row), next: 'The draft is built. Tailor the copy with edit_website_section, tell the owner to proof it in Website → Editor, then publish_website once they approve.' };
}

async function edit_website_section({ workspaceId, args }) {
  const row = await loadSite(workspaceId);
  const pages = pagesOf(row);
  const slug = String(args?.page_slug ?? '').toLowerCase();
  const page = pages.find((p) => (p.slug || '') === slug);
  if (!page) throw new Error(`No page with slug "${slug}". Pages: ${pages.map((p) => `'${p.slug || ''}'`).join(', ')}`);
  page.sections = Array.isArray(page.sections) ? page.sections : [];
  const action = String(args?.action || '');
  const biz = row.business_name || '';
  const pos = Number.isInteger(args?.position) ? Math.max(0, Math.min(args.position, page.sections.length)) : null;

  if (action === 'add') {
    const type = String(args?.type || '');
    if (!SECTION_TYPES[type]) throw new Error(`Unknown section type "${type}"`);
    if (page.sections.length >= 40) throw new Error('A page can hold up to 40 sections');
    const s = mkSection(type, biz);
    if (args?.variant && (SECTION_TYPES[type].variants || []).some((v) => v.id === args.variant)) s.variant = args.variant;
    if (args?.data && typeof args.data === 'object') mergeData(s, args.data);
    if (pos == null) page.sections.push(s); else page.sections.splice(pos, 0, s);
    await savePages(workspaceId, pages);
    return { ok: true, added: sectionSummary(s), page: slug, sections: page.sections.map(sectionSummary) };
  }

  const idx = page.sections.findIndex((s) => s.id === String(args?.section_id || ''));
  if (idx < 0) throw new Error(`No section with id "${args?.section_id}" on page "${slug}". Call get_website for ids.`);
  const s = page.sections[idx];
  if (action === 'update') {
    if (args?.variant) {
      const ok = (SECTION_TYPES[s.type]?.variants || []).some((v) => v.id === args.variant);
      if (!ok) throw new Error(`"${args.variant}" is not a variant of ${s.type}`);
      s.variant = args.variant;
    }
    if (args?.data && typeof args.data === 'object') mergeData(s, args.data);
  } else if (action === 'remove') {
    page.sections.splice(idx, 1);
  } else if (action === 'hide') {
    s.visible = false;
  } else if (action === 'show') {
    s.visible = true;
  } else if (action === 'move') {
    if (pos == null) throw new Error('position is required for move');
    page.sections.splice(idx, 1);
    page.sections.splice(Math.min(pos, page.sections.length), 0, s);
  } else {
    throw new Error("action must be update, add, remove, hide, show or move");
  }
  await savePages(workspaceId, pages);
  return { ok: true, page: slug, sections: page.sections.map(sectionSummary) };
}

// Merge owner-facing fields into section.data. Keys must already exist on
// the section (its type's defaults), so Ivy cannot invent fields the
// renderer ignores. Strings are capped; arrays and objects pass through.
function mergeData(section, data) {
  const defaults = typeof SECTION_TYPES[section.type]?.default === 'function' ? SECTION_TYPES[section.type].default('') : {};
  section.data = section.data && typeof section.data === 'object' ? section.data : {};
  for (const [k, v] of Object.entries(data)) {
    if (!(k in defaults) && !(k in section.data)) continue;
    if (typeof v === 'string') section.data[k] = v.slice(0, 4000);
    else if (typeof v === 'number' || typeof v === 'boolean' || v === null) section.data[k] = v;
    else if (Array.isArray(v)) section.data[k] = v.slice(0, 60);
    else if (typeof v === 'object') section.data[k] = v;
  }
}

async function edit_website_page({ workspaceId, args }) {
  const row = await loadSite(workspaceId);
  const pages = pagesOf(row);
  const action = String(args?.action || '');
  const slug = String(args?.slug ?? '').toLowerCase().trim();
  if (action === 'add') {
    if (!slug || !SLUG_RE.test(slug)) throw new Error('slug must be lowercase letters, digits and hyphens');
    if (pages.some((p) => (p.slug || '') === slug)) throw new Error(`A page with slug "${slug}" already exists`);
    if (pages.length >= 50) throw new Error('Up to 50 pages per site');
    const types = Array.isArray(args?.section_types) && args.section_types.length ? args.section_types : ['hero', 'footer'];
    const bad = types.find((t) => !SECTION_TYPES[t]);
    if (bad) throw new Error(`Unknown section type "${bad}"`);
    const title = String(args?.title || slug).slice(0, 120);
    const page = { id: `p_${Date.now().toString(36)}`, slug, title, inNav: true, sections: types.map((t) => mkSection(t, row.business_name || '')) };
    if (page.sections[0]?.type === 'hero') page.sections[0].data.headline = title;
    pages.push(page);
    await savePages(workspaceId, pages);
    return { ok: true, page: { slug, title, sections: page.sections.map(sectionSummary) } };
  }
  const page = pages.find((p) => (p.slug || '') === slug);
  if (!page) throw new Error(`No page with slug "${slug}"`);
  if (action === 'rename') {
    const title = String(args?.title || '').trim().slice(0, 120);
    if (!title) throw new Error('title is required');
    page.title = title;
  } else if (action === 'remove') {
    if (slug === '') throw new Error('The home page cannot be removed');
    pages.splice(pages.indexOf(page), 1);
  } else if (action === 'show_in_nav') {
    page.inNav = true;
  } else if (action === 'hide_from_nav') {
    page.inNav = false;
  } else {
    throw new Error('action must be add, rename, remove, show_in_nav or hide_from_nav');
  }
  await savePages(workspaceId, pages);
  return { ok: true, pages: pages.map((p) => ({ slug: p.slug || '', title: p.title, inNav: p.inNav !== false })) };
}

// Keep in step with ALLOWED_TEMPLATES in api/website/index.js.
const TEMPLATE_LOOKS = new Set(['clean', 'warm', 'bold', 'studio', 'wellness', 'editorial', 'mono', 'sunset', 'forest', 'brutalist', 'retro', 'art_deco', 'japanese_minimal', 'dark_premium']);

async function update_website({ workspaceId, args }) {
  await loadSite(workspaceId);
  const a = args || {};
  const biz = 'business_name' in a ? String(a.business_name || '').slice(0, 120) || null : null;
  const tpl = a.template ? String(a.template) : null;
  if (tpl && !TEMPLATE_LOOKS.has(tpl)) throw new Error(`Unknown template look "${tpl}"`);
  const seoT = 'seo_title' in a ? String(a.seo_title || '').slice(0, 200) : null;
  const seoD = 'seo_description' in a ? String(a.seo_description || '').slice(0, 400) : null;
  const font = 'font_pair' in a ? (a.font_pair ? String(a.font_pair).slice(0, 60) : null) : undefined;
  await sql`
    UPDATE websites SET
      business_name   = COALESCE(${biz}, business_name),
      template        = COALESCE(${tpl}, template),
      seo_title       = COALESCE(${seoT}, seo_title),
      seo_description = COALESCE(${seoD}, seo_description),
      font_pair       = CASE WHEN ${font !== undefined} THEN ${font ?? null} ELSE font_pair END,
      updated_at      = NOW()
    WHERE workspace_id = ${workspaceId}
  `;
  const row = await loadSite(workspaceId);
  return { ok: true, website: outline(row) };
}

async function publish_website({ workspaceId, userId }) {
  const row = await loadSite(workspaceId);
  if (!row.handle) throw new Error('The site needs a handle before it can be published (set one with create_website or in Website → Settings)');
  const snapshot = {
    template: row.template, sections: row.sections, pages: row.pages, custom_css: row.custom_css,
    font_pair: row.font_pair, seo_title: row.seo_title, seo_description: row.seo_description,
    seo_og_image: row.seo_og_image, favicon_url: row.favicon_url, redirects: row.redirects,
    exit_intent_popup: row.exit_intent_popup, sticky_cta: row.sticky_cta,
  };
  await sql`INSERT INTO website_versions (website_id, snapshot, created_by) VALUES (${row.id}, ${JSON.stringify(snapshot)}::jsonb, ${userId || null})`;
  await sql`DELETE FROM website_versions WHERE website_id = ${row.id} AND id NOT IN (SELECT id FROM website_versions WHERE website_id = ${row.id} ORDER BY created_at DESC LIMIT 50)`;
  const upd = await sql`
    UPDATE websites SET launched = TRUE, published_at = NOW(), published_sections = sections, published_pages = pages, updated_at = NOW()
    WHERE workspace_id = ${workspaceId} RETURNING *
  `;
  return { ok: true, url: siteUrl(upd.rows[0]), publishedAt: upd.rows[0].published_at };
}

export const WEBSITE_HANDLERS = { get_website, create_website, edit_website_section, edit_website_page, update_website, publish_website };
