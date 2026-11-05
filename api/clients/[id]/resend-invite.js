// POST /api/clients/:id/resend-invite
//
// Re-sends the "claim your portal account" invitation to the client.
// Bypasses sendClientInvite's idempotency guard (it skips if
// invite_sent_at is set) so the owner can nudge a slow-claimer.
//
// Stamps clients.invite_sent_at = NOW() only when the email really went
// out, so "Last invited ..." in the client drawer is never a send that a
// client opt-out (or the daily cap) stopped. Response:
//   { sent, reason, inviteSentAt }  (inviteSentAt: the stamp now on file)
import { requireUser } from '../../_lib/auth.js';
import { ensureActiveWorkspace } from '../../_lib/workspaceGate.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { resendClientInvite } from '../../_lib/clientNotify.js';
import { withIdempotency } from '../../_lib/idempotency.js';
import { enforce } from '../../_lib/rate-limit.js';
import { methodNotAllowed, serverError } from '../../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
    const { id: clientId } = req.query;
    // An invite is an email to someone else's inbox: cap the nudges.
    if (await enforce(req, res, [
      { key: `client-invite:ws:${workspaceId}`, max: 60, windowSeconds: 3600 },
      { key: `client-invite:c:${String(clientId).slice(0, 64)}`, max: 5, windowSeconds: 86400 },
    ])) return;

    // Idempotent wrap - a double-click on Resend invite used to fire
    // two invitation emails to the same address.
    const idemp = await withIdempotency(req, user.id, async () => doResendInvite());
    if (idemp.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return res.status(idemp.status).json(idemp.body);

    async function doResendInvite() {
    // Shared with Ivy's resend_client_invite (api/_lib/clientNotify.js).
    const out = await resendClientInvite({ workspaceId, clientId: String(clientId) });
    if (out.error) return { status: out.status || 400, body: { error: out.error } };
    return { status: 200, body: out };
    } // end doResendInvite
  } catch (err) {
    return serverError(res, err);
  }
}
