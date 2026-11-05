// GET /api/me/setup-status - returns the owner's onboarding completion
// state. Drives the "Set up your business" checklist on /dashboard.
//
// Two tiers:
//   REQUIRED - minimum to take a real booking. Checklist won't dismiss
//              the "you still have setup to do" framing while any of
//              these are open.
//   RECOMMENDED - gets the workspace fully ready for business: Stripe
//              for card payments, a website for marketing, a real
//              client to actually use the system, a sent invoice. Counted
//              separately so the checklist can show real progress
//              after required is done without nagging.
//
// Response:
//   {
//     complete: boolean,                 // every required item is done
//     fullyComplete: boolean,            // every item (required + rec) is done
//     items: [
//       { id, label, done, required, href, why }
//     ]
//   }
//
// Returns an empty list for client-only users (the checklist is purely
// owner-side onboarding).
import { sql } from '../_lib/db.js';
import { computeSetupStatus } from '../_lib/setupStatus.js';
import { requireUser } from '../_lib/auth.js';
import { requireSameOrigin } from '../_lib/security.js';
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    let ws;
    try {
      ws = await sql`SELECT id FROM workspaces WHERE owner_id = ${user.id} ORDER BY created_at ASC, id ASC LIMIT 1`;
    } catch (e) {
      // workspaces table missing entirely (very-cold install) - pretend
      // we're done so the dashboard doesn't crash. The wizard will create
      // it on first onboarding action.
      // eslint-disable-next-line no-console
      console.error('[setup-status] workspaces lookup failed:', e.message);
      return ok(res, { complete: true, fullyComplete: true, items: [] });
    }
    if (ws.rows.length === 0) {
      // Not an owner - checklist doesn't apply.
      return ok(res, { complete: true, fullyComplete: true, items: [] });
    }
    const workspaceId = ws.rows[0].id;

    return ok(res, await computeSetupStatus({
      userId: user.id, workspaceId, emailVerifiedAt: user.email_verified_at,
    }));
  } catch (err) {
    return serverError(res, err);
  }
}
