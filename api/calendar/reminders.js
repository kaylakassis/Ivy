// /api/calendar/reminders - the business's appointment reminder settings.
//   GET   → { clients, owner, options, presets, maxReminders, smsAvailable }
//   PATCH → body { clients?: { enabled?, minutes?, channels? },
//                  owner?:   { enabled?, minutes?, channels? } }
//           Partial updates merge onto what is stored. Returns the GET shape.
//
// Owner only (helpers are refused by ensureActiveWorkspace). "clients" is
// the business-wide default for client reminders; "owner" is the owner's
// own heads-up about their appointments and never changes what clients
// get. See api/_lib/reminderSettings.js for how the two are resolved.
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { enforce } from '../_lib/rate-limit.js';
import { ensureCalendarSettings, saveReminderSettings } from '../_lib/calendar.js';
import { isTwilioConfigured } from '../_lib/twilio.js';
import {
  REMINDER_OPTIONS, REMINDER_PRESETS, MAX_REMINDERS,
  mergeReminderPatch, serializeReminderSettings,
} from '../_lib/reminderSettings.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

function shape(row) {
  return {
    ...serializeReminderSettings(row),
    options: REMINDER_OPTIONS,
    presets: REMINDER_PRESETS,
    maxReminders: MAX_REMINDERS,
    smsAvailable: isTwilioConfigured(),
  };
}

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;

    if (req.method === 'GET') {
      const row = await ensureCalendarSettings(workspaceId);
      return ok(res, shape(row));
    }

    if (req.method === 'PATCH') {
      if (await enforce(req, res, [{ key: `reminder-settings:${user.id}`, max: 60, windowSeconds: 600 }])) return;
      const body = await readBody(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) return badRequest(res, 'Body must be an object');
      if (!('clients' in body) && !('owner' in body)) return badRequest(res, 'Nothing to update');

      const row = await ensureCalendarSettings(workspaceId);
      const merged = mergeReminderPatch(row, body);
      if (merged.error) return badRequest(res, merged.error);
      const saved = await saveReminderSettings(workspaceId, merged);
      return ok(res, shape(saved));
    }

    return methodNotAllowed(res, ['GET', 'PATCH']);
  } catch (err) {
    return serverError(res, err);
  }
}
