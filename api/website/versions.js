// /api/website/versions
//   GET  → list the last 50 snapshots for the current owner's site
//   POST → roll back to a specific snapshot id (body: { id })
//
// Every Publish stores a snapshot via api/website/publish.js. This
// endpoint lets owners see what's stored and revert. Roll-back writes
// the snapshot back into the live row and creates a NEW snapshot of
// the current state first - so you can always undo your undo.

import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { readBody } from '../_lib/body.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';
import { requireSameOrigin } from '../_lib/security.js';
import { ensureSchemaApplied } from '../_lib/ensureSchema.js';
import { restoreWebsiteVersion } from '../_lib/websiteVersions.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    await ensureSchemaApplied();
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
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
      // roll-back-able (api/_lib/websiteVersions.js, shared with Ivy).
      const cur = await sql`SELECT * FROM websites WHERE id = ${siteId}`;
      await restoreWebsiteVersion(cur.rows[0], found.rows[0].snapshot, user.id);
      return ok(res, { restored: true });
    }

    return methodNotAllowed(res, ['GET', 'POST']);
  } catch (err) {
    return serverError(res, err);
  }
}
