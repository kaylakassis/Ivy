// POST /api/me/two-step-prompt   { dismiss: true }
// Remembers (per user, in users.ui_prefs.twoStepPromptDismissedAt) that the
// "Turn on 2-step verification" suggestion on the dashboard was dismissed, so
// it does not come back on this or any other device.
import { sql } from '../_lib/db.js';
import { requireUser, invalidateUserCache } from '../_lib/auth.js';
import { requireSameOrigin } from '../_lib/security.js';
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const stamp = new Date().toISOString();
    // jsonb merge in one statement so other ui_prefs keys are never clobbered.
    await sql`
      UPDATE users
         SET ui_prefs = COALESCE(ui_prefs, '{}'::jsonb) || jsonb_build_object('twoStepPromptDismissedAt', ${stamp}::text)
       WHERE id = ${user.id}
    `;
    invalidateUserCache(user.id);
    return ok(res, { dismissed: true, dismissedAt: stamp });
  } catch (err) {
    return serverError(res, err);
  }
}
