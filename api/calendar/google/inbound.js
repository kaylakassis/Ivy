// /api/calendar/google/inbound
//   GET  → current toggle state + last sync timestamp + last error
//   POST → toggle inbound busy-block sync on / off (body: { enabled })
//          Enabling fires an immediate pull so slots reflect right away
//          instead of waiting up to an hour for the cron.
//   PATCH → manual "sync now" - owner clicks "Sync now" in the drawer.
import { sql } from '../../_lib/db.js';
import { requireUser } from '../../_lib/auth.js';
import { ensureActiveWorkspace } from '../../_lib/workspaceGate.js';
import { readBody } from '../../_lib/body.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { pullBusyTimes } from '../../_lib/googleSync.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../../_lib/json.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;

    if (req.method === 'GET') {
      const { rows } = await sql`
        SELECT google_block_inbound, google_inbound_last_sync_at,
               google_inbound_last_error,
               google_refresh_token_encrypted IS NOT NULL AS connected
        FROM calendar_settings WHERE workspace_id = ${workspaceId}
      `;
      const r = rows[0] || {};
      return ok(res, {
        connected:    !!r.connected,
        enabled:      !!r.google_block_inbound,
        lastSyncAt:   r.google_inbound_last_sync_at || null,
        lastError:    r.google_inbound_last_error  || null,
      });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const enabled = !!body.enabled;
      const cur = await sql`
        SELECT google_refresh_token_encrypted IS NOT NULL AS connected
        FROM calendar_settings WHERE workspace_id = ${workspaceId}
      `;
      if (enabled && !cur.rows[0]?.connected) {
        return badRequest(res, 'Connect Google Calendar first');
      }
      await sql`
        UPDATE calendar_settings SET
          google_block_inbound      = ${enabled},
          google_inbound_last_error = NULL
        WHERE workspace_id = ${workspaceId}
      `;
      // Fire-and-forget sync so the slot grid catches up immediately.
      // Don't await - the 200 returns fast and the cron picks it up
      // again on the next tick if this best-effort call dies.
      if (enabled) pullBusyTimes({ workspaceId }).catch(() => {});
      else {
        // Disabling clears the mirrored rows so existing personal
        // events stop blocking slots right away.
        await sql`DELETE FROM external_busy_blocks WHERE workspace_id = ${workspaceId} AND source = 'google'`;
      }
      return ok(res, { enabled });
    }

    if (req.method === 'PATCH') {
      const out = await pullBusyTimes({ workspaceId });
      if (!out.ok) {
        await sql`
          UPDATE calendar_settings SET google_inbound_last_error = ${out.reason}
          WHERE workspace_id = ${workspaceId}
        `;
        return badRequest(res, out.reason);
      }
      return ok(res, out);
    }

    return methodNotAllowed(res, ['GET', 'POST', 'PATCH']);
  } catch (err) {
    return serverError(res, err);
  }
}
