// GET /api/calendar/google/status
// Cheap read for the Sync drawer. Returns whether the workspace is
// connected, what email it's linked to, and when it connected. Never
// returns the encrypted refresh token.
import { sql } from '../../_lib/db.js';
import { requireUser } from '../../_lib/auth.js';
import { ensureActiveWorkspace } from '../../_lib/workspaceGate.js';
import { isGoogleConfigured } from '../../_lib/google.js';
import { methodNotAllowed, ok, serverError } from '../../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;

    const { rows } = await sql`
      SELECT google_email, google_connected_at,
             google_refresh_token_encrypted IS NOT NULL AS connected
      FROM calendar_settings
      WHERE workspace_id = ${workspaceId}
    `;
    const r = rows[0];
    return ok(res, {
      configured: isGoogleConfigured(),
      connected:  !!r?.connected,
      email:      r?.google_email || null,
      connectedAt: r?.google_connected_at || null,
    });
  } catch (err) {
    return serverError(res, err);
  }
}
