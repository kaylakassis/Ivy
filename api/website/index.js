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
import { readBody } from '../_lib/body.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';
import { requireSameOrigin } from "../_lib/security.js";

const ALLOWED_TEMPLATES = new Set([
  'clean', 'warm', 'bold',
  'studio', 'wellness', 'editorial', 'mono', 'sunset', 'forest',
]);
const ALLOWED_FONT_PAIRS = new Set([
  'fraunces_inter', 'space_inter', 'fraunces_fraunces',
  'inter_inter', 'playfair_lato', 'dm_serif_dm_sans',
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
    launched:      row.launched,
    visibility:    row.visibility || 'public',
    publishedAt:   row.published_at,
    updatedAt:     row.updated_at,
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
function sanitizePage(p, idx) {
  if (!p || typeof p !== 'object') throw new Error(`Page ${idx + 1} is malformed`);
  const id = String(p.id || '').slice(0, 64) || `p_${Date.now().toString(36)}_${idx}`;
  // Empty slug is the home page; otherwise must match SLUG_RE.
  const slug = p.slug === '' ? '' : String(p.slug || '').toLowerCase().slice(0, 40);
  if (slug !== '' && !SLUG_RE.test(slug)) throw new Error(`Page ${idx + 1}: invalid slug`);
  const title = String(p.title || 'Untitled').slice(0, 120);
  const sections = Array.isArray(p.sections) ? p.sections : [];
  return { id, slug, title, sections, inNav: p.inNav !== false };
}

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);

    if (req.method === 'GET') {
      const row = await getOrCreate(workspaceId);
      return ok(res, { website: serialize(row) });
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
          handle         = COALESCE(${patch.handle ?? null},         handle),
          business_name  = COALESCE(${patch.businessName ?? null},   business_name),
          template       = COALESCE(${patch.template ?? null},       template),
          font_pair      = COALESCE(${patch.fontPair ?? null},       font_pair),
          custom_css     = COALESCE(${patch.customCss ?? null},      custom_css),
          sections       = COALESCE(${JSON.stringify(patch.sections ?? null)}::jsonb, sections),
          pages          = COALESCE(${JSON.stringify(patch.pages ?? null)}::jsonb,    pages),
          custom_domain  = COALESCE(${patch.customDomain ?? null},   custom_domain),
          launched       = COALESCE(${patch.launched ?? null},       launched),
          visibility     = COALESCE(${patch.visibility ?? null},     visibility),
          updated_at     = NOW()
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
