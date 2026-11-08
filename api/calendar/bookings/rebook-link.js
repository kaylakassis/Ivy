// POST /api/calendar/bookings/rebook-link  { id }
//
// The owner's "Send rebook link" button in the booking drawer: emails (and,
// with consent, texts) the booking's client a signed link that opens the
// booking page with the same service picked and a suggested day and time
// (api/_lib/rebook.js). The owner is acting, so no approval card; it is
// rate limited per client per day and per business per hour. Honours the
// client's email opt-outs, SMS consent and contact blocks: the answer says
// what went out and why anything did not. Owner only (helpers never send
// to clients from here).
import { sql } from '../../_lib/db.js';
import { requireUser } from '../../_lib/auth.js';
import { ensureActiveWorkspace } from '../../_lib/workspaceGate.js';
import { readBody } from '../../_lib/body.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { sendRebookLink, rebookSendAllowed, rebookLimitMessage } from '../../_lib/rebook.js';
import { badRequest, methodNotAllowed, notFound, ok, serverError } from '../../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
    const body = await readBody(req);
    const id = body.id ? String(body.id).slice(0, 64) : null;
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return badRequest(res, 'id is required');
    const b = await sql`
      SELECT id, client_id, service_id FROM bookings
       WHERE id = ${id} AND workspace_id = ${workspaceId} LIMIT 1`;
    const booking = b.rows[0];
    if (!booking) return notFound(res, 'Booking not found');
    if (!booking.client_id) return badRequest(res, 'This booking is not linked to a client yet');
    const gate = await rebookSendAllowed({ workspaceId, clientId: booking.client_id });
    if (!gate.allowed) {
      res.setHeader('Retry-After', String(gate.retryAfterSeconds || 3600));
      return res.status(429).json({ error: rebookLimitMessage(gate) });
    }
    const out = await sendRebookLink({ workspaceId, clientId: booking.client_id, serviceId: booking.service_id || null, bookingId: booking.id });
    if (out.error) return badRequest(res, out.error);
    return ok(res, {
      sent: out.ok, emailed: out.emailed, texted: out.texted,
      emailReason: out.emailReason, smsReason: out.smsReason,
      url: out.url,
      suggestion: { date: out.suggestion.date, startMin: out.suggestion.startMin, weekdayName: out.suggestion.weekdayName, weeks: out.suggestion.weeks, usual: out.suggestion.usual },
      rebookLinkSentAt: out.ok ? new Date().toISOString() : null,
    });
  } catch (err) {
    return serverError(res, err);
  }
}
