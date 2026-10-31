// GET /api/helper/me?workspaceId=…
//
// The helper shell's context: which business this session is helping at
// (the chosen one, or the first), the helper's staff record, and the
// business's timezone for rendering the schedule. 402 when the owner's
// subscription has lapsed (requireHelper), which the shell renders as
// "This business is paused on Ivy".
import { sql } from '../_lib/db.js';
import { requireSameOrigin } from '../_lib/security.js';
import { requireHelper } from '../_lib/helpers.js';
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const gate = await requireHelper(req, res, { workspaceId: req.query.workspaceId });
    if (!gate) return;
    const { user, membership, memberships } = gate;

    let timezone = null;
    try {
      const r = await sql`SELECT timezone FROM calendar_settings WHERE workspace_id = ${membership.workspaceId} LIMIT 1`;
      timezone = r.rows[0]?.timezone || null;
    } catch { /* default to the device zone */ }

    return ok(res, {
      user: { id: user.id, email: user.email, name: user.name },
      business: {
        workspaceId: membership.workspaceId,
        businessName: membership.businessName,
        timezone,
      },
      staff: { id: membership.staffId, name: membership.staffName },
      helps: memberships.map((m) => ({
        workspaceId: m.workspaceId, businessName: m.businessName, staffId: m.staffId, active: m.active,
      })),
    });
  } catch (err) {
    return serverError(res, err);
  }
}
