// POST /api/website/publish - marks the current user's website as published.
// Requires a handle to be set. Also flips launched=true.

import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { requireSameOrigin } from '../_lib/security.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';
import { saveWebsiteVersion } from '../_lib/websiteVersions.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
    const { rows } = await sql`SELECT * FROM websites WHERE workspace_id = ${workspaceId}`;
    if (rows.length === 0) return badRequest(res, 'No website to publish');
    if (!rows[0].handle) return badRequest(res, 'Set a handle before publishing');
    const site = rows[0];

    // Snapshot the current state into website_versions BEFORE flipping
    // the publish flag, so every publish is a roll-back point (the newest
    // 50 are kept). Shared with Ivy's publish (api/_lib/websiteVersions.js).
    await saveWebsiteVersion(site, user.id);

    const updated = await sql`
      UPDATE websites SET
        launched           = TRUE,
        published_at       = NOW(),
        published_sections = sections,
        published_pages    = pages,
        updated_at         = NOW()
      WHERE workspace_id = ${workspaceId}
      RETURNING handle, published_at
    `;
    return ok(res, updated.rows[0]);
  } catch (err) {
    return serverError(res, err);
  }
}
