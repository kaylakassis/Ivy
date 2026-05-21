// /api/website
//   GET  → current user's website row (creates if missing)
//   PUT  → upsert (partial) the website row; rejects duplicate handle
//
// New schema fields surfaced here:
//   • pages       — array of page objects (multi-page sites)
//   • customCss   — owner-supplied CSS injected into the rendered site
//   • fontPair    — preset id overriding the template's font choice
//
// `sections` (legacy single-page) and `pages` (multi-page) coexist for
// backward compat. If `pages` is empty, the renderer treats `sections`
// as the home page. New sites populate `pages` from day 1.

import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { requireActiveSubscription } from '../_lib/subscriptionGate.js';
import { readBody } from '../_lib/body.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';
import { requireSameOrigin } from "../_lib/security.js";

const ALLOWED_TEMPLATES = new Set([
  'clean', 'warm', 'bold',
  'studio', 'wellness', 'editorial', 'mono', 'sunset', 'forest',
  'brutalist', 'retro', 'art_deco', 'japanese_minimal', 'dark_premium',
]);
const ALLOWED_FONT_PAIRS = new Set([
  'fraunces_inter', 'space_inter', 'fraunces_fraunces',
  'inter_inter', 'playfair_lato', 'dm_serif_dm_sans',
  'bodoni_montserrat', 'cormorant_open', 'archivo_archivo',
  'abril_lato', 'ibm_ibm', 'oswald_lora', 'spectral_jost',
  'marcellus_nunito', 'bebas_inter',
]);
const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const SLUG_RE   = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

function serialize(row) {
  if (!row) return null;
  return {
    id:            row.id,
    handle:        row.handle,
    businessName:  row.business_name,
    template:      row.template,
    sections:      row.sections || [],
    pages:         Array.isArray(row.pages) ? row.pages : [],
    customCss:     row.custom_css || '',
    fontPair:      row.font_pair || null,
    customDomain:  row.custom_domain,
    domainStatus:  row.domain_status || null,
    launched:      row.launched,
    visibility:    row.visibility || 'public',
    publishedAt:   row.published_at,
    updatedAt:     row.updated_at,
    seoTitle:        row.seo_title || '',
    seoDescription:  row.seo_description || '',
    seoOgImage:      row.seo_og_image || '',
    faviconUrl:      row.favicon_url || '',
    redirects:         Array.isArray(row.redirects) ? row.redirects : [],
    formDestinations:  Array.isArray(row.form_destinations) ? row.form_destinations : [],
    exitIntentPopup:   row.exit_intent_popup || null,
    stickyCta:         row.sticky_cta || null,
    scheduledPublishAt: row.scheduled_publish_at || null,
    scheduledPages:     Array.isArray(row.scheduled_pages) ? row.scheduled_pages : null,
  };
}

async function getOrCreate(workspaceId) {
  const found = await sql`SELECT * FROM websites WHERE workspace_id = ${workspaceId}`;
  if (found.rows.length > 0) return found.rows[0];
  const created = await sql`
    INSERT INTO websites (workspace_id) VALUES (${workspaceId}) RETURNING *
  `;
  return created.rows[0];
}

// Validate + sanitize a single page object. Rejects entries that don't
// match the shape so we don't persist arbitrary JSON.
function sanitizePopup(p) {
  if (!p || typeof p !== 'object') return null;
  return {
    enabled:  !!p.enabled,
    headline: p.headline ? String(p.headline).slice(0, 120) : '',
    sub:      p.sub      ? String(p.sub).slice(0, 280) : '',
    cta:      p.cta      ? String(p.cta).slice(0, 60) : '',
    ctaLink:  p.ctaLink  ? String(p.ctaLink).slice(0, 500) : '',
  };
}

function sanitizeStickyCta(p) {
  if (!p || typeof p !== 'object') return null;
  return {
    enabled:  !!p.enabled,
    text:     p.text ? String(p.text).slice(0, 120) : '',
    link:     p.link ? String(p.link).slice(0, 500) : '',
    position: p.position === 'top' ? 'top' : 'bottom',
  };
}

function sanitizePage(p, idx) {
  if (!p || typeof p !== 'object') throw new Error(`Page ${idx + 1} is malformed`);
  const id = String(p.id || '').slice(0, 64) || `p_${Date.now().toString(36)}_${idx}`;
  // Empty slug is the home page; otherwise must match SLUG_RE.
  const slug = p.slug === '' ? '' : String(p.slug || '').toLowerCase().slice(0, 40);
  if (slug !== '' && !SLUG_RE.test(slug)) throw new Error(`Page ${idx + 1}: invalid slug`);
  const title = String(p.title || 'Untitled').slice(0, 120);
  const sections = Array.isArray(p.sections) ? p.sections : [];
  const out = { id, slug, title, sections, inNav: p.inNav !== false };
  // Per-page SEO overrides — all optional. We only persist the fields
  // when they're set so the page JSON stays compact for older sites.
  if (p.metaTitle)       out.metaTitle       = String(p.metaTitle).slice(0, 200);
  if (p.metaDescription) out.metaDescription = String(p.metaDescription).slice(0, 400);
  if (p.ogImage)         out.ogImage         = String(p.ogImage).slice(0, 1000);
  return out;
}

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);
    if (req.method !== 'GET' && req.method !== 'HEAD' && !(await requireActiveSubscription(workspaceId, req, res))) return;

    if (req.method === 'GET') {
      try {
        const row = await getOrCreate(workspaceId);
        return ok(res, { website: serialize(row) });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[website GET] failed (returning null):', e.message);
        // Returning null (not 500) lets the editor render its empty state
        // so the user can at least see the website tab instead of a
        // crashed page.
        return ok(res, { website: null });
      }
    }

    if (req.method === 'PUT') {
      const body = await readBody(req);
      const patch = {};

      if ('handle' in body) {
        const h = body.handle == null ? null : String(body.handle).toLowerCase().trim();
        if (h !== null && !HANDLE_RE.test(h)) {
          return badRequest(res, 'Invalid handle (lowercase letters, digits, hyphens; 1–40 chars)');
        }
        patch.handle = h;
      }
      if ('businessName' in body) patch.businessName = body.businessName ? String(body.businessName).slice(0, 120) : null;
      if ('template' in body) {
        if (!ALLOWED_TEMPLATES.has(body.template)) return badRequest(res, 'Unknown template');
        patch.template = body.template;
      }
      if ('fontPair' in body) {
        if (body.fontPair == null) patch.fontPair = null;
        else if (!ALLOWED_FONT_PAIRS.has(body.fontPair)) {
          return badRequest(res, 'Unknown font pair');
        } else {
          patch.fontPair = body.fontPair;
        }
      }
      if ('customCss' in body) {
        const css = body.customCss == null ? null : String(body.customCss).slice(0, 32000);
        patch.customCss = css;
      }
      if ('sections' in body) {
        if (!Array.isArray(body.sections)) return badRequest(res, 'sections must be an array');
        patch.sections = body.sections;
      }
      if ('pages' in body) {
        if (!Array.isArray(body.pages)) return badRequest(res, 'pages must be an array');
        if (body.pages.length > 50) return badRequest(res, 'Up to 50 pages per site');
        try {
          patch.pages = body.pages.map(sanitizePage);
          // Slug uniqueness across pages.
          const slugs = patch.pages.map((p) => p.slug);
          if (new Set(slugs).size !== slugs.length) {
            return badRequest(res, 'Page slugs must be unique');
          }
        } catch (e) {
          return badRequest(res, e.message);
        }
      }
      if ('customDomain' in body) patch.customDomain = body.customDomain ? String(body.customDomain).slice(0, 255) : null;
      if ('launched' in body) patch.launched = !!body.launched;
      // Site-level SEO defaults. Empty strings clear the override
      // (the renderer falls back to derived values from the hero/about).
      if ('seoTitle' in body)       patch.seoTitle       = body.seoTitle       == null ? null : String(body.seoTitle).slice(0, 200);
      if ('seoDescription' in body) patch.seoDescription = body.seoDescription == null ? null : String(body.seoDescription).slice(0, 400);
      if ('seoOgImage' in body)     patch.seoOgImage     = body.seoOgImage     == null ? null : String(body.seoOgImage).slice(0, 1000);
      if ('faviconUrl' in body)     patch.faviconUrl     = body.faviconUrl     == null ? null : String(body.faviconUrl).slice(0, 1000);
      // Block-D fields. Arrays are stored as JSONB; null/empty clears.
      if ('redirects' in body) {
        if (!Array.isArray(body.redirects)) return badRequest(res, 'redirects must be an array');
        if (body.redirects.length > 100) return badRequest(res, 'Up to 100 redirects per site');
        patch.redirects = body.redirects
          .filter((r) => r && typeof r === 'object' && r.from && r.to)
          .map((r) => ({ from: String(r.from).slice(0, 200), to: String(r.to).slice(0, 500) }));
      }
      if ('formDestinations' in body) {
        if (!Array.isArray(body.formDestinations)) return badRequest(res, 'formDestinations must be an array');
        if (body.formDestinations.length > 50) return badRequest(res, 'Up to 50 form destinations');
        patch.formDestinations = body.formDestinations
          .filter((d) => d && typeof d === 'object' && d.formId && d.type)
          .map((d) => ({
            formId: String(d.formId).slice(0, 64),
            type:   ['email', 'webhook'].includes(d.type) ? d.type : 'email',
            config: d.config && typeof d.config === 'object' ? d.config : {},
          }));
      }
      if ('exitIntentPopup' in body) patch.exitIntentPopup = body.exitIntentPopup === null ? null : sanitizePopup(body.exitIntentPopup);
      if ('stickyCta' in body)       patch.stickyCta       = body.stickyCta       === null ? null : sanitizeStickyCta(body.stickyCta);
      if ('scheduledPublishAt' in body) {
        const v = body.scheduledPublishAt;
        patch.scheduledPublishAt = v ? new Date(v) : null;
      }
      if ('scheduledPages' in body) {
        if (body.scheduledPages === null) patch.scheduledPages = null;
        else if (!Array.isArray(body.scheduledPages)) return badRequest(res, 'scheduledPages must be an array');
        else patch.scheduledPages = body.scheduledPages.map(sanitizePage);
      }
      if ('visibility' in body) {
        if (!['public', 'private', 'only_me'].includes(body.visibility)) {
          return badRequest(res, 'visibility must be public / private / only_me');
        }
        patch.visibility = body.visibility;
      }

      if (patch.handle) {
        const clash = await sql`
          SELECT id FROM websites
          WHERE handle = ${patch.handle} AND workspace_id <> ${workspaceId}
        `;
        if (clash.rows.length > 0) return badRequest(res, 'That handle is taken');
      }

      // Ensure a row exists, then apply patch.
      await getOrCreate(workspaceId);

      const updated = await sql`
        UPDATE websites SET
          handle             = COALESCE(${patch.handle ?? null},         handle),
          business_name      = COALESCE(${patch.businessName ?? null},   business_name),
          template           = COALESCE(${patch.template ?? null},       template),
          font_pair          = COALESCE(${patch.fontPair ?? null},       font_pair),
          custom_css         = COALESCE(${patch.customCss ?? null},      custom_css),
          sections           = COALESCE(${JSON.stringify(patch.sections ?? null)}::jsonb, sections),
          pages              = COALESCE(${JSON.stringify(patch.pages ?? null)}::jsonb,    pages),
          custom_domain      = COALESCE(${patch.customDomain ?? null},   custom_domain),
          launched           = COALESCE(${patch.launched ?? null},       launched),
          visibility         = COALESCE(${patch.visibility ?? null},     visibility),
          seo_title          = COALESCE(${patch.seoTitle ?? null},       seo_title),
          seo_description    = COALESCE(${patch.seoDescription ?? null}, seo_description),
          seo_og_image       = COALESCE(${patch.seoOgImage ?? null},     seo_og_image),
          favicon_url        = COALESCE(${patch.faviconUrl ?? null},     favicon_url),
          redirects          = COALESCE(${JSON.stringify(patch.redirects ?? null)}::jsonb, redirects),
          form_destinations  = COALESCE(${JSON.stringify(patch.formDestinations ?? null)}::jsonb, form_destinations),
          exit_intent_popup  = COALESCE(${JSON.stringify(patch.exitIntentPopup ?? null)}::jsonb, exit_intent_popup),
          sticky_cta         = COALESCE(${JSON.stringify(patch.stickyCta ?? null)}::jsonb, sticky_cta),
          scheduled_publish_at = COALESCE(${patch.scheduledPublishAt ?? null}, scheduled_publish_at),
          scheduled_pages    = COALESCE(${JSON.stringify(patch.scheduledPages ?? null)}::jsonb, scheduled_pages),
          updated_at         = NOW()
        WHERE workspace_id = ${workspaceId}
        RETURNING *
      `;
      return ok(res, { website: serialize(updated.rows[0]) });
    }

    return methodNotAllowed(res, ['GET', 'PUT']);
  } catch (err) {
    return serverError(res, err);
  }
}
