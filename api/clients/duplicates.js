// /api/clients/duplicates - possible duplicate clients in this business.
//
//   GET                → { total, pairs: [{ key, confidence, label, reasons,
//                          keepId, a, b }] } where a / b carry name, email,
//                          phone, stage, createdAt, lastBooking, portalClaimed
//                          and counts { bookings, invoices, messages,
//                          documents, packages, notes }.
//   GET ?count=1       → { total } (the "Possible duplicates (N)" entry)
//   POST { action: 'dismiss', clientIds: [a, b] }
//                      → { ok } "Not the same person": the pair never comes back.
//   POST { action: 'count', clientIds: [...] (max 5000) }
//                      → { total } open pairs involving any of these clients
//                        (the "N possible duplicates to review" line after an
//                        import).
//
// Owner only (a helper account gets the standard 403). Every lookup is
// scoped to the owner's workspace; ids from another business read as "not
// found". Detection itself: api/_lib/clientDuplicates.js.
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { enforce } from '../_lib/rate-limit.js';
import { listDuplicatePairs, countDuplicatesInvolving, dismissDuplicatePair } from '../_lib/clientDuplicates.js';
import { recordWorkspaceAudit } from '../_lib/audit.js';
import { badRequest, methodNotAllowed, notFound, ok, serverError } from '../_lib/json.js';

const MAX_COUNT_IDS = 5000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
    if (await enforce(req, res, req.method === 'GET'
      ? [{ key: `client-dupes:get:ws:${workspaceId}`, max: 300, windowSeconds: 3600 }]
      : [{ key: `client-dupes:post:ws:${workspaceId}`, max: 600, windowSeconds: 3600 }])) return;

    if (req.method === 'GET') {
      if (String(req.query?.count || '') === '1') {
        const { total } = await listDuplicatePairs(workspaceId, { limit: 0, withCounts: false });
        return ok(res, { total });
      }
      return ok(res, await listDuplicatePairs(workspaceId));
    }

    const body = await readBody(req);
    const action = String(body?.action || '');
    const ids = Array.isArray(body?.clientIds) ? body.clientIds : null;
    if (action === 'dismiss') {
      if (!ids || ids.length !== 2 || !ids.every((x) => UUID_RE.test(String(x)))) {
        return badRequest(res, 'Pick the two clients that are not the same person.');
      }
      const out = await dismissDuplicatePair(workspaceId, ids[0], ids[1], user.id);
      if (!out.ok) return notFound(res, out.error);
      await recordWorkspaceAudit(req, {
        workspaceId, actor: user, action: 'client.duplicate_dismissed',
        target: { kind: 'client', id: String(ids[0]) }, meta: { other_client_id: String(ids[1]) },
      });
      return ok(res, { ok: true });
    }
    if (action === 'count') {
      if (!ids) return badRequest(res, 'clientIds[] is required');
      if (ids.length > MAX_COUNT_IDS) return badRequest(res, `At most ${MAX_COUNT_IDS} clients at a time`);
      const clean = ids.map(String).filter((x) => UUID_RE.test(x));
      return ok(res, { total: await countDuplicatesInvolving(workspaceId, clean) });
    }
    return badRequest(res, 'Unknown action');
  } catch (err) {
    return serverError(res, err, req);
  }
}
