// /api/me/notifications-clients
//   GET   → for each business the user is a client of, return their per-
//           workspace email notification preferences.
//   PATCH → update one client's prefs. Body: { clientId, prefs: { bookings: false, ... } }
//
// Preferences live on clients.notification_prefs (per-workspace because
// the clients table is workspace-scoped). The user can opt out of
// bookings emails from business A while keeping them on for business B.
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { myClientIds, ids } from '../_lib/clientPortal.js';
import {
  EMAIL_NOTIFY_TYPES, EMAIL_NOTIFY_LABELS, defaultEmailPrefs,
} from '../_lib/notificationPrefs.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const memberships = await myClientIds(user);
    const myIds = ids(memberships);
    if (myIds.length === 0) {
      return ok(res, {
        memberships: [],
        emailTypes: EMAIL_NOTIFY_TYPES,
        emailLabels: EMAIL_NOTIFY_LABELS,
      });
    }

    if (req.method === 'GET') {
      const { rows } = await sql.query(
        `SELECT id, workspace_id, notification_prefs FROM clients WHERE id = ANY($1)`,
        [myIds],
      );
      const prefsById = new Map(rows.map((r) => [r.id, r.notification_prefs || {}]));
      const out = memberships.map((m) => ({
        clientId: m.clientId,
        workspaceId: m.workspaceId,
        businessName: m.businessName,
        prefs: defaultEmailPrefs(prefsById.get(m.clientId) || {}),
      }));
      return ok(res, {
        memberships: out,
        emailTypes: EMAIL_NOTIFY_TYPES,
        emailLabels: EMAIL_NOTIFY_LABELS,
      });
    }

    if (req.method === 'PATCH') {
      const body = await readBody(req);
      const clientId = body.clientId ? String(body.clientId) : null;
      const prefs = body && typeof body.prefs === 'object' ? body.prefs : null;
      if (!clientId) return badRequest(res, 'clientId is required');
      if (!prefs) return badRequest(res, 'prefs is required');
      if (!myIds.includes(clientId)) return badRequest(res, 'Not your client membership');

      const r = await sql`SELECT notification_prefs FROM clients WHERE id = ${clientId}`;
      const next = { ...(r.rows[0]?.notification_prefs || {}) };
      for (const t of EMAIL_NOTIFY_TYPES) {
        if (t in prefs) next[t] = !!prefs[t];
      }
      await sql`
        UPDATE clients SET notification_prefs = ${JSON.stringify(next)}::jsonb
        WHERE id = ${clientId}
      `;
      return ok(res, {
        clientId,
        prefs: defaultEmailPrefs(next),
        emailTypes: EMAIL_NOTIFY_TYPES,
        emailLabels: EMAIL_NOTIFY_LABELS,
      });
    }

    return methodNotAllowed(res, ['GET', 'PATCH']);
  } catch (err) {
    return serverError(res, err);
  }
}
