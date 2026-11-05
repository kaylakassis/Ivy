// POST /api/invoices/archive  body: { id } or { ids: [uuid] (max 200), archived?: boolean }
// Hides settled invoices (paid, refunded, void) from the owner's main
// Finance list, or brings them back with archived: false. Archiving never
// deletes anything and never changes revenue, refunds or exports. Invoices
// that cannot be archived are listed in `skipped` with the reason.
//   → { invoices: [serialized], changed, skipped: [{ id, number, why }] }
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { enforce } from '../_lib/rate-limit.js';
import { setInvoicesArchived } from '../_lib/invoiceActions.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
    if (await enforce(req, res, [{ key: `invoice-archive:ws:${workspaceId}`, max: 120, windowSeconds: 3600 }])) return;
    const body = await readBody(req);
    const ids = Array.isArray(body.ids) ? body.ids : (body.id ? [body.id] : []);
    const archived = body.archived === undefined ? true : !(body.archived === false || body.archived === 'false');
    try {
      const out = await setInvoicesArchived({ workspaceId, ids, archived, actor: user, req });
      return ok(res, out);
    } catch (e) {
      if (e.code === 'refused') return badRequest(res, e.message);
      throw e;
    }
  } catch (err) {
    return serverError(res, err);
  }
}
