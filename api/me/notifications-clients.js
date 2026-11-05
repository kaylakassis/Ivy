// /api/me/notifications-clients
//   GET   → for each business the user is a client of, return their per-
//           workspace email notification preferences.
//   PATCH → update one client's prefs. Body: { clientId, prefs: { bookings: false, ... } }
//
// Preferences are per business and per address: a switch here applies to
// every clients row of that business holding the same email, and reads
// OFF whenever any unsubscribe (link, one-click, an earlier switch) has
// muted it (api/_lib/notificationPrefs.js). The user can opt out of
// bookings emails from business A while keeping them on for business B.
//
// Turning a category OFF records the opt-out and tells the business owner
// (api/_lib/clientOptouts.js). Turning it back ON is the only way an
// opt-out is ever cleared: owners cannot re-enable a client's emails.
import { requireUser } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { myClientIds, ids } from '../_lib/clientPortal.js';
import {
  CLIENT_EMAIL_TYPES, EMAIL_NOTIFY_LABELS, effectiveClientEmailPrefs,
} from '../_lib/notificationPrefs.js';
import { applyPortalEmailPrefs } from '../_lib/clientOptouts.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';
import { sql } from '../_lib/db.js';

// Appointment reminders switch: clients.notification_prefs.reminders.
// false = no reminder emails, texts or pushes from that business, whatever
// the business set (api/_lib/reminderSettings.js). Applied to every row
// of that business for this person (same row, same login or same email).
// PATCH { clientId, reminders: false } sets it; GET returns `reminders`
// on each membership.
async function remindersOn(clientId) {
  const { rows } = await sql`SELECT notification_prefs FROM clients WHERE id = ${clientId}`;
  return (rows[0]?.notification_prefs || {}).reminders !== false;
}
async function setReminders({ clientId, userId, on }) {
  await sql`
    UPDATE clients c
       SET notification_prefs = COALESCE(c.notification_prefs, '{}'::jsonb) || jsonb_build_object('reminders', ${on}::boolean)
      FROM clients me
     WHERE me.id = ${clientId}
       AND c.workspace_id = me.workspace_id
       AND (c.id = me.id OR c.user_id = ${userId}
            OR (COALESCE(me.email, '') <> '' AND LOWER(c.email) = LOWER(me.email)))`;
}

const LABELS = Object.fromEntries(CLIENT_EMAIL_TYPES.map((t) => [t, EMAIL_NOTIFY_LABELS[t]]));

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
        emailTypes: CLIENT_EMAIL_TYPES,
        emailLabels: LABELS,
      });
    }

    if (req.method === 'GET') {
      const out = [];
      for (const m of memberships) {
        // eslint-disable-next-line no-await-in-loop
        const prefs = await effectiveClientEmailPrefs(m.clientId);
        out.push({
          clientId: m.clientId,
          workspaceId: m.workspaceId,
          businessName: m.businessName,
          prefs,
          // eslint-disable-next-line no-await-in-loop
          reminders: await remindersOn(m.clientId),
        });
      }
      return ok(res, {
        memberships: out,
        emailTypes: CLIENT_EMAIL_TYPES,
        emailLabels: LABELS,
      });
    }

    if (req.method === 'PATCH') {
      const body = await readBody(req);
      const clientId = body.clientId ? String(body.clientId) : null;
      const prefs = body && typeof body.prefs === 'object' ? body.prefs : null;
      const hasReminders = typeof body.reminders === 'boolean';
      if (!clientId) return badRequest(res, 'clientId is required');
      if (!prefs && !hasReminders) return badRequest(res, 'prefs is required');
      if (!myIds.includes(clientId)) return badRequest(res, 'Not your client membership');

      if (prefs) {
        const wanted = {};
        for (const t of CLIENT_EMAIL_TYPES) if (t in prefs) wanted[t] = !!prefs[t];
        if (Object.keys(wanted).length) await applyPortalEmailPrefs({ clientId, prefs: wanted });
      }
      if (hasReminders) await setReminders({ clientId, userId: user.id, on: body.reminders });
      return ok(res, {
        clientId,
        prefs: await effectiveClientEmailPrefs(clientId),
        reminders: await remindersOn(clientId),
        emailTypes: CLIENT_EMAIL_TYPES,
        emailLabels: LABELS,
      });
    }

    return methodNotAllowed(res, ['GET', 'PATCH']);
  } catch (err) {
    return serverError(res, err);
  }
}
