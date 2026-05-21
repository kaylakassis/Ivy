// POST /api/website/publish — marks the current user's website as published.
// Requires a handle to be set. Also flips launched=true.

import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { requireActiveSubscription } from '../_lib/subscriptionGate.js';
import { requireSameOrigin } from '../_lib/security.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);
    if (req.method !== 'GET' && req.method !== 'HEAD' && !(await requireActiveSubscription(workspaceId, req, res))) return;

    const { rows } = await sql`SELECT * FROM websites WHERE workspace_id = ${workspaceId}`;
    if (rows.length === 0) return badRequest(res, 'No website to publish');
    if (!rows[0].handle) return badRequest(res, 'Set a handle before publishing');
    const site = rows[0];

    // Snapshot the current live state into website_versions BEFORE
    // flipping the publish flag. Owners get a roll-back point for
    // every publish, capped at the last 50 entries to keep the table
    // bounded (we prune older ones below).
    const snapshot = {
      template:        site.template,
      sections:        site.sections,
      pages:           site.pages,
      custom_css:      site.custom_css,
      font_pair:       site.font_pair,
      seo_title:       site.seo_title,
      seo_description: site.seo_description,
      seo_og_image:    site.seo_og_image,
      favicon_url:     site.favicon_url,
      redirects:       site.redirects,
      exit_intent_popup: site.exit_intent_popup,
      sticky_cta:      site.sticky_cta,
    };
    await sql`
      INSERT INTO website_versions (website_id, snapshot, created_by)
      VALUES (${site.id}, ${JSON.stringify(snapshot)}::jsonb, ${user.id})
    `;
    // Prune to the most recent 50 — cheap, infrequent, keeps storage flat.
    await sql`
      DELETE FROM website_versions
      WHERE website_id = ${site.id}
        AND id NOT IN (
          SELECT id FROM website_versions
          WHERE website_id = ${site.id}
          ORDER BY created_at DESC LIMIT 50
        )
    `;

    const updated = await sql`
      UPDATE websites SET
        launched     = TRUE,
        published_at = NOW(),
        updated_at   = NOW()
      WHERE workspace_id = ${workspaceId}
      RETURNING handle, published_at
    `;
    return ok(res, updated.rows[0]);
  } catch (err) {
    return serverError(res, err);
  }
}
