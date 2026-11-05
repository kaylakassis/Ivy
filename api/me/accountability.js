// /api/me/accountability - the owner's accountability partner.
//   GET   → (?view=settings: settings and labels only)
//           { enabled, emailEnabled, frequency, kinds, kindLabels,
//             frequencyLabels, snoozedToday, lastSentAt, items, total }
//           items = what needs attention right now (first names only),
//           the same list the dashboard and Ivy read.
//   PATCH → { enabled?, emailEnabled?, frequency?, kinds? } change settings.
//   POST  → { action: 'snooze' | 'unsnooze' } "Not today" from the
//           dashboard card: no partner message today and the card folds.
//
// Owners only: a helper-only account gets 403 (ensureWorkspace). Every
// read and write is for the signed-in owner's own business.
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { requireSameOrigin } from '../_lib/security.js';
import { readBody } from '../_lib/body.js';
import { enforce } from '../_lib/rate-limit.js';
import {
  partnerOverview, readPartnerSettings, cleanSettingsPatch, savePartnerSettings, snoozeToday,
  PARTNER_KIND_LABELS, PARTNER_FREQUENCY_LABELS, PARTNER_KINDS, PARTNER_FREQUENCIES,
} from '../_lib/accountability.js';
import { recordWorkspaceAudit } from '../_lib/audit.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

const LABELS = {
  kindOrder: PARTNER_KINDS, kindLabels: PARTNER_KIND_LABELS,
  frequencyOrder: PARTNER_FREQUENCIES, frequencyLabels: PARTNER_FREQUENCY_LABELS,
};

export default async function handler(req, res) {
  if (!['GET', 'PATCH', 'POST'].includes(req.method)) return methodNotAllowed(res, ['GET', 'PATCH', 'POST']);
  if (req.method !== 'GET' && !requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);

    if (req.method === 'GET') {
      // ?view=settings: just the switches (the Notifications screen), no list.
      if (String(req.query?.view || '') === 'settings') {
        return ok(res, { ...(await readPartnerSettings(user.id)), ...LABELS });
      }
      return ok(res, { ...(await partnerOverview({ userId: user.id, workspaceId })), ...LABELS });
    }

    if (await enforce(req, res, [{ key: `partner:user:${user.id}`, max: 60, windowSeconds: 3600 }])) return;
    const body = (await readBody(req)) || {};

    if (req.method === 'POST') {
      const action = String(body.action || '');
      if (action !== 'snooze' && action !== 'unsnooze') return badRequest(res, "action must be 'snooze' or 'unsnooze'");
      const snoozedToday = await snoozeToday(workspaceId, action === 'snooze');
      return ok(res, { snoozedToday });
    }

    const patch = cleanSettingsPatch(body);
    if (patch.error) return badRequest(res, patch.error);
    const settings = await savePartnerSettings(user.id, patch);
    if ('accountability' in patch.notificationPatch) {
      await recordWorkspaceAudit(req, {
        workspaceId, actor: user,
        action: patch.notificationPatch.accountability ? 'accountability_partner.on' : 'accountability_partner.off',
      });
    }
    return ok(res, { ...settings, ...LABELS });
  } catch (err) {
    return serverError(res, err);
  }
}
