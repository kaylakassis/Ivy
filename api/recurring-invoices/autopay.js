// POST /api/recurring-invoices/autopay   body: { id, action }
//   action 'request' -> turn autopay on for the series: emails the client a
//                       request to approve (or re-sends it, at most hourly).
//                       Also used to ask again after a price rise / card change.
//   action 'off'     -> turn autopay off: ends any request or approval; the
//                       client is told if they had approved.
// Returns { schedule } with the autopay summary.
//
// The owner can only ASK. Charging needs the client's own approval, stored
// by /api/me/autopay. Static sibling so Vercel doesn't route /autopay to
// the [id].js handler.
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { enforce } from '../_lib/rate-limit.js';
import { serializeRecurring } from '../_lib/recurring.js';
import { withAutopay, requestAutopay, ownerTurnOff, AutopayError } from '../_lib/autopay.js';
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
    if (await enforce(req, res, [{ key: `autopay-owner:ws:${workspaceId}`, max: 60, windowSeconds: 3600 }])) return;

    const body = await readBody(req).catch(() => ({}));
    const id = typeof body?.id === 'string' ? body.id : '';
    const action = typeof body?.action === 'string' ? body.action : '';
    if (!UUID.test(id)) return badRequest(res, 'id is required');
    if (action !== 'request' && action !== 'off') return badRequest(res, 'action must be request or off');

    const r = await sql`SELECT * FROM recurring_invoices WHERE id = ${id} AND workspace_id = ${workspaceId}`;
    if (!r.rows[0]) return notFound(res, 'Schedule not found');

    let result = {};
    try {
      if (action === 'request') result = await requestAutopay({ workspaceId, seriesId: id, userId: user.id });
      else result = { ended: await ownerTurnOff({ workspaceId, seriesId: id }) };
    } catch (e) {
      if (e instanceof AutopayError) return res.status(e.status || 400).json({ error: e.message });
      throw e;
    }
    const fresh = await sql`SELECT * FROM recurring_invoices WHERE id = ${id} AND workspace_id = ${workspaceId}`;
    const [schedule] = await withAutopay(workspaceId, fresh.rows, serializeRecurring);
    return ok(res, { schedule, emailed: !!result.emailed });
  } catch (err) {
    return serverError(res, err);
  }
}
