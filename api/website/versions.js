// /api/website/versions
//   GET  → list the last 50 snapshots for the current owner's site
//   POST → roll back to a specific snapshot id (body: { id })
//
// Every Publish stores a snapshot via api/website/publish.js. This
// endpoint lets owners see what's stored and revert. Roll-back writes
// the snapshot back into the live row and creates a NEW snapshot of
// the current state first — so you can always undo your undo.

import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { requireActiveSubscription } from '../_lib/subscriptionGate.js';
import { readBody } from '../_lib/body.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';
import { requireSameOrigin } from '../_lib/security.js';
import { ensureSchemaApplied } from '../_lib/ensureSchema.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    await ensureSchemaApplied();
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);
    if (req.method !== 'GET' && req.method !== 'HEAD' && !(await requireActiveSubscription(workspaceId, req, res))) return;
    const siteRow = await sql`SELECT id FROM websites WHERE workspace_id = ${workspaceId}`;
    if (siteRow.rows.length === 0) {
      if (req.method === 'GET') return ok(res, { versions: [] });
      return badRequest(res, 'No site');
    }
    const siteId = siteRow.rows[0].id;

    if (req.method === 'GET') {
      const v = await sql`
        SELECT id, created_at,
               (snapshot->>'template')                AS template,
               jsonb_array_length(COALESCE(snapshot->'pages', '[]'::jsonb))   AS page_count
        FROM website_versions
        WHERE website_id = ${siteId}
        ORDER BY created_at DESC
        LIMIT 50
      `;
      return ok(res, { versions: v.rows });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const versionId = String(body?.id || '');
      if (!versionId) return badRequest(res, 'id is required');

      const found = await sql`
        SELECT snapshot FROM website_versions
        WHERE id = ${versionId} AND website_id = ${siteId}
      `;
      if (found.rows.length === 0) return badRequest(res, 'Version not found');

      // Snapshot the CURRENT state first so the roll-back is itself
      // roll-back-able.
      const cur = await sql`SELECT * FROM websites WHERE id = ${siteId}`;
      const cs = cur.rows[0];
      await sql`
        INSERT INTO website_versions (website_id, snapshot, created_by)
        VALUES (${siteId}, ${JSON.stringify({
          template: cs.template, sections: cs.sections, pages: cs.pages,
          custom_css: cs.custom_css, font_pair: cs.font_pair,
          seo_title: cs.seo_title, seo_description: cs.seo_description,
          seo_og_image: cs.seo_og_image, favicon_url: cs.favicon_url,
          redirects: cs.redirects, exit_intent_popup: cs.exit_intent_popup,
          sticky_cta: cs.sticky_cta,
        })}::jsonb, ${user.id})
      `;

      const snap = found.rows[0].snapshot;
      await sql`
        UPDATE websites SET
          template          = COALESCE(${snap.template ?? null}, template),
          sections          = COALESCE(${JSON.stringify(snap.sections ?? null)}::jsonb, sections),
          pages             = COALESCE(${JSON.stringify(snap.pages ?? null)}::jsonb, pages),
          custom_css        = COALESCE(${snap.custom_css ?? null}, custom_css),
          font_pair         = COALESCE(${snap.font_pair ?? null}, font_pair),
          seo_title         = COALESCE(${snap.seo_title ?? null}, seo_title),
          seo_description   = COALESCE(${snap.seo_description ?? null}, seo_description),
          seo_og_image      = COALESCE(${snap.seo_og_image ?? null}, seo_og_image),
          favicon_url       = COALESCE(${snap.favicon_url ?? null}, favicon_url),
          redirects         = COALESCE(${JSON.stringify(snap.redirects ?? null)}::jsonb, redirects),
          exit_intent_popup = COALESCE(${JSON.stringify(snap.exit_intent_popup ?? null)}::jsonb, exit_intent_popup),
          sticky_cta        = COALESCE(${JSON.stringify(snap.sticky_cta ?? null)}::jsonb, sticky_cta),
          updated_at        = NOW()
        WHERE id = ${siteId}
      `;
      return ok(res, { restored: true });
    }

    return methodNotAllowed(res, ['GET', 'POST']);
  } catch (err) {
    return serverError(res, err);
  }
}
