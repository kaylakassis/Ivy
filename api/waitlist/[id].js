// /api/waitlist/:id - owner actions on one waitlist entry.
//   DELETE → remove the person from the list (status 'cancelled'; any open
//            offer is withdrawn). The row stays for history.
//   POST   → { offer: { date, startMin, endMin } } offer them a time: sends
//            the one-tap claim link by email and (with consent) text
//            (api/_lib/waitlist.js offerTimeToEntry).
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { requireSameOrigin } from '../_lib/security.js';
import { readBody } from '../_lib/body.js';
import { removeWaitlistEntry, offerTimeToEntry, serializeOffer } from '../_lib/waitlist.js';
import { badRequest, methodNotAllowed, noContent, notFound, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'DELETE' && req.method !== 'POST') return methodNotAllowed(res, ['DELETE', 'POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
    const { id } = req.query;
    if (!/^[0-9a-fA-F-]{36}$/.test(String(id || ''))) return notFound(res, 'Waitlist entry not found');

    if (req.method === 'DELETE') {
      const r = await removeWaitlistEntry({ workspaceId, id });
      if (r.notFound) return notFound(res, 'Waitlist entry not found or already processed');
      return noContent(res);
    }

    const body = await readBody(req);
    const o = body?.offer;
    if (!o || typeof o !== 'object') return badRequest(res, 'offer is required');
    const out = await offerTimeToEntry({
      workspaceId, entryId: id, dateISO: String(o.date || ''), startMin: Number(o.startMin), endMin: Number(o.endMin),
      offeredBy: 'owner',
    });
    if (out.error) return res.status(out.status || 400).json({ error: out.error });
    return ok(res, { offer: serializeOffer(out.offer) });
  } catch (err) {
    return serverError(res, err);
  }
}
