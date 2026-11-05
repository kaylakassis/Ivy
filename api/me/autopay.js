// /api/me/autopay - the client's automatic-payment agreements, across every
// business they are a client of.
//   GET  -> { agreements: [...] }  open requests, active approvals, and ones
//           that ended in the last 60 days. Display fragments only (brand,
//           last4), never Stripe ids.
//   POST { action, agreementId, ... }
//     'add-card'   -> { url } Stripe Checkout (setup mode) on the business's
//                     connected account; comes back to the same request.
//     'sync-card'  { setupSessionId } -> { card } read the finished setup
//                     ourselves so approval never waits on a webhook.
//     'authorize'  { agree: true } -> the client approves; the exact words,
//                     time, IP, user agent and card are stored for good.
//     'turn-off'   -> ends the request or approval; the business is told.
//
// Every lookup is pinned to the caller's own clients rows (myClientIds), so
// an agreement id from another person or business is simply "not found".
import { requireUser } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { enforce, getClientIp } from '../_lib/rate-limit.js';
import { myClientIds, ids } from '../_lib/clientPortal.js';
import {
  listForClient, startAddCard, syncSetupSession, authorizeAgreement, clientTurnOff, AutopayError,
} from '../_lib/autopay.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const myIds = ids(await myClientIds(user));

    if (req.method === 'GET') {
      if (myIds.length === 0) return ok(res, { agreements: [] });
      return ok(res, { agreements: await listForClient(myIds) });
    }

    if (req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);
    if (await enforce(req, res, [{ key: `autopay-me:user:${user.id}`, max: 30, windowSeconds: 600 }])) return;
    const body = await readBody(req).catch(() => ({}));
    const action = typeof body?.action === 'string' ? body.action : '';
    const agreementId = typeof body?.agreementId === 'string' ? body.agreementId : '';
    if (!UUID.test(agreementId)) return badRequest(res, 'agreementId is required');
    if (myIds.length === 0) return res.status(404).json({ error: 'Not found' });

    try {
      if (action === 'add-card') {
        return ok(res, await startAddCard({ myIds, agreementId }));
      }
      if (action === 'sync-card') {
        const sessionId = typeof body?.setupSessionId === 'string' ? body.setupSessionId.slice(0, 255) : '';
        return ok(res, { card: await syncSetupSession({ myIds, agreementId, sessionId }) });
      }
      if (action === 'authorize') {
        if (body?.agree !== true) return badRequest(res, 'Please tick the box to agree first.');
        const ua = req.headers?.['user-agent'];
        await authorizeAgreement({
          user, myIds, agreementId,
          ip: getClientIp(req),
          userAgent: Array.isArray(ua) ? ua[0] : ua,
        });
        return ok(res, { agreements: await listForClient(myIds) });
      }
      if (action === 'turn-off') {
        await clientTurnOff({ myIds, agreementId });
        return ok(res, { agreements: await listForClient(myIds) });
      }
    } catch (e) {
      if (e instanceof AutopayError) return res.status(e.status || 400).json({ error: e.message });
      if (e?.code === 'no_stripe_connection') return badRequest(res, "This business can't take card payments right now.");
      throw e;
    }
    return badRequest(res, 'Unknown action');
  } catch (err) {
    return serverError(res, err);
  }
}
