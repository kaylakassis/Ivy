// /api/clients/invite-settings
//   GET   → { inviteNewClients: boolean }
//   PATCH { inviteNewClients: boolean } → same shape
//
// The business's "Invite new clients automatically" switch
// (calendar_settings.invite_new_clients; NULL = on). When on, a client
// added through Add client (the box starts ticked), Ivy, or a booking
// that creates them gets one portal invite email. Imports never follow
// it: they stay quiet unless the owner opts in for that import.
//
// Owner only (helpers are refused by ensureActiveWorkspace without a
// helper option). Writes are same-origin and rate limited.
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { enforce } from '../_lib/rate-limit.js';
import { invalidateCalendarSettings } from '../_lib/calendar.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'PATCH') return methodNotAllowed(res, ['GET', 'PATCH']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;

    if (req.method === 'PATCH') {
      if (await enforce(req, res, [{ key: `client-invite-settings:ws:${workspaceId}`, max: 60, windowSeconds: 3600 }])) return;
      const body = await readBody(req);
      if (typeof body?.inviteNewClients !== 'boolean') return badRequest(res, 'inviteNewClients must be true or false');
      await sql`
        INSERT INTO calendar_settings (workspace_id, invite_new_clients)
        VALUES (${workspaceId}, ${body.inviteNewClients})
        ON CONFLICT (workspace_id) DO UPDATE SET invite_new_clients = EXCLUDED.invite_new_clients
      `;
      invalidateCalendarSettings(workspaceId);
      return ok(res, { inviteNewClients: body.inviteNewClients });
    }

    const { rows } = await sql`SELECT invite_new_clients FROM calendar_settings WHERE workspace_id = ${workspaceId}`;
    return ok(res, { inviteNewClients: rows[0]?.invite_new_clients !== false });
  } catch (err) {
    return serverError(res, err);
  }
}
