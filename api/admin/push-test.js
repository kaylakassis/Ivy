// POST /api/admin/push-test
// Fires a test web-push notification to the calling super-admin's own
// subscriptions, so the operator can preview the actual rendering
// (title, body, icon, tap-through URL) without waiting for a real
// nudge or reminder to fire. Mirrors the shape of an Ivy nudge so
// the preview is representative, not a contrived test string.
//
// Returns { sent, removed } from the push fan-out. `sent: 0` with no
// `removed` means you don't have any push subscriptions registered on
// this account — accept the browser's push permission prompt and retry.
//
// Calls sendPushToUser directly (not notifyOwner) on purpose: a test
// must NOT insert a row into the notifications feed.
import { requireSameOrigin } from '../_lib/security.js';
import { requireSuperAdmin, getAdminActor } from '../_lib/admin.js';
import { recordAudit } from '../_lib/audit.js';
import { sendPushToUser } from '../_lib/push.js';
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  if (!(await requireSuperAdmin(req, res))) return;

  try {
    const actor = await getAdminActor(req);
    if (!actor?.id) return serverError(res, new Error('Could not resolve admin user'));
    await recordAudit(req, { actor, action: 'admin.push_test' });

    // Mirrors an Ivy nudge payload so the preview is realistic.
    // No `type` passed → bypasses the user notification-pref gate
    // (per push.js: admin-side / system-critical sends are
    // intentionally unconditional).
    const result = await sendPushToUser({
      userId: actor.id,
      payload: {
        title: 'THRYVE · test notification',
        body: 'If you can read this, push notifications are working on this device.',
        url: '/admin?tab=settings',
        tag: 'admin-push-test',
      },
    });
    return ok(res, result);
  } catch (err) {
    return serverError(res, err);
  }
}
