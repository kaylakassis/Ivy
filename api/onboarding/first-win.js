// GET/POST /api/onboarding/first-win
//
// The "Your business is ready" cards (end of onboarding, or the first
// dashboard visit) and the one-time first-booking / first-payment moments.
//
//   GET   → { status, celebrations }
//   POST  { action: 'prepare' }                     → drafts the booking link,
//                                                     website and first invoice
//                                                     from the owner's real
//                                                     answers; idempotent
//   POST  { action: 'shared' }                      → owner copied / shared the
//                                                     booking link (clears the
//                                                     dashboard to-do)
//   POST  { action: 'seen' }                        → owner continued past the
//                                                     ready cards
//   POST  { action: 'celebration_seen', kind }      → the dashboard showed the
//                                                     first-booking / payment
//                                                     moment; never again
//
// Onboarding endpoints are exempt from the subscription gate (an owner must
// be able to finish setup regardless of billing): ensureWorkspace, not
// ensureActiveWorkspace, like the rest of api/onboarding/*.
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';
import { ensureSchemaApplied } from '../_lib/ensureSchema.js';
import { invalidateOwnerWorkspace } from '../_lib/clientPortal.js';
import {
  firstWinStatus, prepareFirstWin, markBookingLinkShared, markFirstWinSeen,
  pendingCelebrations, markCelebrationShown,
} from '../_lib/firstWin.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    await ensureSchemaApplied();
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);

    if (req.method === 'GET') {
      const [status, celebrations] = await Promise.all([firstWinStatus(workspaceId), pendingCelebrations(workspaceId)]);
      return ok(res, { status, celebrations });
    }

    if (req.method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      const action = String(body?.action || 'prepare');
      if (action === 'prepare') {
        const status = await prepareFirstWin(workspaceId, body?.answers || {});
        // The booking slug may have just been set; /api/me caches the
        // owner workspace row that carries it.
        invalidateOwnerWorkspace(user.id);
        return ok(res, { status });
      }
      if (action === 'shared') {
        await markBookingLinkShared(workspaceId);
        return ok(res, { status: await firstWinStatus(workspaceId) });
      }
      if (action === 'seen') {
        await markFirstWinSeen(workspaceId);
        return ok(res, { ok: true });
      }
      if (action === 'celebration_seen') {
        const kind = String(body?.kind || '');
        if (kind !== 'booking' && kind !== 'payment') return badRequest(res, 'kind must be booking or payment');
        await markCelebrationShown(workspaceId, kind);
        return ok(res, { celebrations: await pendingCelebrations(workspaceId) });
      }
      return badRequest(res, 'Unknown action');
    }

    return methodNotAllowed(res, ['GET', 'POST']);
  } catch (err) {
    return serverError(res, err);
  }
}
