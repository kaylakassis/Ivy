// POST /api/calendar/bookings/refund-deposit   body: { id, amount? }
//
// Owner only (helpers never move money). Refunds the booking's deposit (or
// part of it) through the processor that took it. The part of a deposit
// that already paid a late-cancel / no-show fee is never refunded here.
// Exactly once per refunded total (api/_lib/bookingFees.js).
import { sql } from '../../_lib/db.js';
import { requireUser } from '../../_lib/auth.js';
import { ensureActiveWorkspace } from '../../_lib/workspaceGate.js';
import { readBody } from '../../_lib/body.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { enforce } from '../../_lib/rate-limit.js';
import { serializeBooking } from '../../_lib/calendar.js';
import { refundDepositManually } from '../../_lib/bookingFees.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
    if (await enforce(req, res, [{ key: `deposit-refund:ws:${workspaceId}`, max: 60, windowSeconds: 3600 }])) return;

    const body = await readBody(req);
    const id = body.id ? String(body.id) : null;
    if (!id) return badRequest(res, 'id is required');
    let amount = null;
    if (body.amount != null && body.amount !== '') {
      amount = Number(body.amount);
      if (!Number.isFinite(amount) || amount <= 0) return badRequest(res, 'amount must be a positive number');
    }
    const out = await refundDepositManually({ workspaceId, bookingId: id, amount });
    if (out.notFound) return badRequest(res, 'Booking not found');
    if (out.nothingHeld) return badRequest(res, 'There is no paid deposit left to refund on this booking.');
    if (out.coversFee) return badRequest(res, 'The deposit paid the cancellation fee, so there is nothing left to refund.');
    if (out.deduped) return badRequest(res, 'A refund for this deposit is already in progress.');
    const row = (await sql`SELECT * FROM bookings WHERE id = ${id} AND workspace_id = ${workspaceId}`).rows[0];
    if (out.error) return res.status(402).json({ error: out.error, booking: serializeBooking(row) });
    return ok(res, { booking: serializeBooking(row), refunded: (out.refunded || 0) / 100 });
  } catch (err) {
    return serverError(res, err);
  }
}
