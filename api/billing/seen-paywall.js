// POST /api/billing/seen-paywall
//
// Tiny beacon the Paywall component fires on mount. Stamps
// workspaces.paywall_first_seen_at the first time an owner SEES the wall,
// so the win-back cron has a target even when the owner bounces without
// tripping any gated endpoint. Idempotent: COALESCE keeps the original
// first-seen timestamp on every subsequent call.
//
// Why a beacon instead of relying on the gate: the dashboard renders the
// Paywall purely from the client-side subscription context (no gated
// request is made), so without this endpoint a new owner who finishes
// onboarding and immediately bounces off the wall would never be flagged
// as a win-back candidate.
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
      UPDATE workspaces
         SET paywall_first_seen_at = COALESCE(paywall_first_seen_at, NOW())
       WHERE id = ${workspaceId} AND paywall_first_seen_at IS NULL
    `;
    return ok(res, { ok: true });
  } catch (err) {
    return serverError(res, err);
  }
}
