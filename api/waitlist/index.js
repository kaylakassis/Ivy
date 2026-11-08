// GET /api/waitlist - owner: the waitlist (api/_lib/waitlist.js).
//   ?all=1 includes fulfilled / removed / expired history.
// Returns { entries, summary } where summary counts people waiting per
// service (the same numbers the dashboard's attention list uses).
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { requireSameOrigin } from '../_lib/security.js';
import { listWaitlist, waitlistSummary } from '../_lib/waitlist.js';
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
    const includeClosed = req.query.all === '1';
    const [entries, summary] = await Promise.all([
      listWaitlist(workspaceId, { includeClosed }),
      waitlistSummary(workspaceId),
    ]);
    return ok(res, { entries, summary });
  } catch (err) {
    return serverError(res, err);
  }
}
