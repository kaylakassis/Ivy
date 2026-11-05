// POST /api/calendar/bookings/charge-fee
//   body: { id, kind: 'late_cancel' | 'no_show', amount?: number }
//
// Manual fee charge. Used when the cron / cancel flow couldn't
// auto-charge (no card on file at the time, or the policy was
// added after the fact) and the owner is now charging out of band.
// Defaults amount to the service's policy amount; owner can override
// (e.g. partial waiver).
import { sql } from '../../_lib/db.js';
import { requireUser } from '../../_lib/auth.js';
import { ensureActiveWorkspace } from '../../_lib/workspaceGate.js';
import { readBody } from '../../_lib/body.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { chargeFeeManually } from '../../_lib/bookingFees.js';
import { serializeBooking } from '../../_lib/calendar.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;

    const body = await readBody(req);
    const id = body.id ? String(body.id) : null;
    const kind = (body.kind || '').toString();
    if (!id) return badRequest(res, 'id is required');
    if (!['late_cancel', 'no_show'].includes(kind)) {
      return badRequest(res, 'kind must be late_cancel or no_show');
    }

    let amount = null;
    if (body.amount != null && body.amount !== '') {
      amount = Number(body.amount);
      if (!Number.isFinite(amount) || amount <= 0) return badRequest(res, 'amount must be a positive number');
      if (amount > 1_000_000) return badRequest(res, 'amount too large');
    }

    // Shared, exactly-once fee logic (api/_lib/bookingFees.js). Without an
    // amount it charges the policy fee less any deposit the business kept.
    const out = await chargeFeeManually({ workspaceId, bookingId: id, kind, amount });
    if (out.notFound) return badRequest(res, 'Booking not found');
    if (out.alreadyCharged || out.deduped) return badRequest(res, 'A fee was already charged for this booking');
    if (out.openInvoice) {
      return badRequest(res, `Invoice ${out.openInvoice} for this fee is already ${out.invoiceStatus}. Void it first if you want to charge the card instead.`);
    }
    if (out.noFee) return badRequest(res, 'This service has no fee set. Enter an amount to charge.');
    const row = (await sql`SELECT * FROM bookings WHERE id = ${id} AND workspace_id = ${workspaceId}`).rows[0];
    if (out.error) {
      return res.status(402).json({
        error: out.error,
        chargeError: out.error,
        feeInvoice: out.invoice || null,
        booking: serializeBooking(row),
      });
    }
    return ok(res, {
      booking: serializeBooking(row),
      charged: out.charged > 0,
      chargeAmount: out.charged / 100,
      feeFromDeposit: (out.fromDeposit || 0) / 100,
    });
  } catch (err) {
    // Stripe 402 (e.g. card declined / requires authentication) ends up here.
    // eslint-disable-next-line no-console
    console.error('[bookings/charge-fee] failed:', err.message);
    return serverError(res, err);
  }
}
