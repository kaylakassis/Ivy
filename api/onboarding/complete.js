// POST /api/onboarding/complete
// Marks the authenticated owner's workspace as onboarded so the wizard
// never appears again. Idempotent - safe to call from "Skip" buttons too.
import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { requireSameOrigin } from '../_lib/security.js';
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);

    await sql`
      UPDATE workspaces SET onboarded_at = COALESCE(onboarded_at, NOW())
      WHERE id = ${workspaceId}
    `;
    return ok(res, { ok: true });
  } catch (err) {
    return serverError(res, err);
  }
}
