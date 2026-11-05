// POST /api/cancellation-policy/request   body { bookingId }
//
// Owner only. For a booking the business made itself (no client
// acceptance), email the client a link to read and accept the current
// cancellation policy. The link is single-use, expires in 30 days and only
// its sha256 is stored. One email per booking per 10 minutes, and a
// per-workspace hourly cap.
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { enforce } from '../_lib/rate-limit.js';
import { sendPolicyAcceptanceRequest } from '../_lib/cancellationPolicy.js';
import { badRequest, methodNotAllowed, notFound, ok, serverError } from '../_lib/json.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
    if (await enforce(req, res, [{ key: `cpolicy-request:ws:${workspaceId}`, max: 50, windowSeconds: 3600 }])) return;

    const body = await readBody(req);
    const bookingId = body?.bookingId ? String(body.bookingId) : '';
    if (!UUID.test(bookingId)) return badRequest(res, 'bookingId is required');

    const out = await sendPolicyAcceptanceRequest({ workspaceId, bookingId });
    if (out.error) return out.status === 404 ? notFound(res, out.error) : badRequest(res, out.error);
    return ok(res, out);
  } catch (err) {
    return serverError(res, err);
  }
}
