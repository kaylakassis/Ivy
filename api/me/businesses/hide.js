// POST /api/me/businesses/hide  body: { clientId, hidden? }
//
// Client-side control: hide a business connection from MY portal (or
// unhide with hidden:false). A business links into a client's portal
// automatically when its client record carries the client's verified
// email - correct, but the client never chose it, so they get a way
// out. Hiding only sets clients.portal_hidden_at for THEIR OWN row:
// the business keeps its client record, history, and nothing on the
// owner side changes. myClientIds filters hidden rows, so the
// business (and its bookings/invoices/messages) stops surfacing
// everywhere in the portal at once.
//
// Ownership: the row must already be linked to the signed-in user
// (user_id match) - you can only hide your own connections.
import { sql } from '../../_lib/db.js';
import { requireUser } from '../../_lib/auth.js';
import { readBody } from '../../_lib/body.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const body = await readBody(req);
    const clientId = body.clientId ? String(body.clientId) : null;
    if (!clientId) return badRequest(res, 'clientId is required');
    const hidden = body.hidden !== false;

    const { rows } = await sql`
      UPDATE clients
      SET portal_hidden_at = ${hidden ? new Date() : null}
      WHERE id = ${clientId} AND user_id = ${user.id}
      RETURNING id
    `;
    if (rows.length === 0) return badRequest(res, 'Connection not found');
    return ok(res, { hidden });
  } catch (err) {
    return serverError(res, err);
  }
}
