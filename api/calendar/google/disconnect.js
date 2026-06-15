// POST /api/calendar/google/disconnect
// Clears all Google sync state for the workspace. Best-effort revoke of
// the refresh_token at Google so our app no longer appears in the user's
// connected-apps list. The dedicated "THRYVE Bookings" calendar isn't
// deleted — owner can keep or remove it themselves.
import { sql } from '../../_lib/db.js';
import { requireUser } from '../../_lib/auth.js';
import { ensureActiveWorkspace } from '../../_lib/workspaceGate.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { decrypt } from '../../_lib/secrets.js';
import { revokeToken } from '../../_lib/google.js';
import { methodNotAllowed, ok, serverError } from '../../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;

    const { rows } = await sql`
      SELECT google_refresh_token_encrypted FROM calendar_settings
      WHERE workspace_id = ${workspaceId}
    `;
    const enc = rows[0]?.google_refresh_token_encrypted;
    if (enc) {
      try {
        const refreshToken = decrypt(enc);
        await revokeToken(refreshToken);
      } catch (err) {
        // Continue with the local clear even if the remote revoke fails.
        // eslint-disable-next-line no-console
        console.warn('[google] revoke failed (continuing):', err.message);
      }
    }

    await sql`
      UPDATE calendar_settings SET
        google_refresh_token_encrypted = NULL,
        google_calendar_id             = NULL,
        google_email                   = NULL,
        google_connected_at            = NULL
      WHERE workspace_id = ${workspaceId}
    `;
    // Also clear any stored event ids so a fresh re-connect can start clean.
    await sql`
      UPDATE bookings SET google_event_id = NULL
      WHERE workspace_id = ${workspaceId} AND google_event_id IS NOT NULL
    `;
    return ok(res, { connected: false });
  } catch (err) {
    return serverError(res, err);
  }
}
