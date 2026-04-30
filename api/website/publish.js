// POST /api/website/publish — marks the current user's website as published.
// Requires a handle to be set. Also flips launched=true.

import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { requireSameOrigin } from '../_lib/security.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);

    const { rows } = await sql`SELECT handle FROM websites WHERE workspace_id = ${workspaceId}`;
    if (rows.length === 0) return badRequest(res, 'No website to publish');
    if (!rows[0].handle) return badRequest(res, 'Set a handle before publishing');

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
