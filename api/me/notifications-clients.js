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
      if (!clientId) return badRequest(res, 'clientId is required');
      if (!prefs) return badRequest(res, 'prefs is required');
      if (!myIds.includes(clientId)) return badRequest(res, 'Not your client membership');

      const wanted = {};
      for (const t of CLIENT_EMAIL_TYPES) if (t in prefs) wanted[t] = !!prefs[t];
      await applyPortalEmailPrefs({ clientId, prefs: wanted });
      return ok(res, {
        clientId,
        prefs: await effectiveClientEmailPrefs(clientId),
        emailTypes: CLIENT_EMAIL_TYPES,
        emailLabels: LABELS,
      });
    }

    return methodNotAllowed(res, ['GET', 'PATCH']);
  } catch (err) {
    return serverError(res, err);
  }
}
