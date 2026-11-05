// POST /api/calendar/bookings/no-show   body: { id, chargeFee?: boolean }
// DELETE /api/calendar/bookings/no-show body: { id }   → undo the mark
//
// Owner-only. Marks a booking as a no-show and (optionally) auto-
// charges the service's no-show fee against the client's saved card.
//
// chargeFee defaults to TRUE when the service has a non-zero fee +
// the client has a card on file. The owner can pass FALSE to mark
// the no-show without charging (e.g. they're letting it slide).
//
// DELETE clears no_show_at but deliberately KEEPS fee_charged_* -
// if a fee was actually charged, undoing the flag must not erase the
// record of real money moving (refunds happen in Stripe, not here).
//
// Lives as a static sibling to /api/calendar/bookings/[id].js so
// Vercel routes /no-show here, /[id] to the dynamic handler.
import { sql } from '../../_lib/db.js';
import { requireUser } from '../../_lib/auth.js';
import { ensureActiveWorkspace } from '../../_lib/workspaceGate.js';
import { readBody } from '../../_lib/body.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { chargeNoShowFee } from '../../_lib/bookingFees.js';
import { serializeBooking } from '../../_lib/calendar.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'DELETE') {
    return methodNotAllowed(res, ['POST', 'DELETE']);
  }
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res, { helper: 'schedule' });
    if (!workspaceId) return;
    // Helper mode: the booking without its money fields.
    const bopts = { redactMoney: !!req.helper };

    const body = await readBody(req);
    const id = body.id ? String(body.id) : null;
    if (!id) return badRequest(res, 'id is required');

    if (req.method === 'DELETE') {
      // Undo a stray no-show click. Fee columns stay untouched (see header).
      const undone = await sql`
        UPDATE bookings SET no_show_at = NULL, updated_at = NOW()
        WHERE id = ${id} AND workspace_id = ${workspaceId}
          AND no_show_at IS NOT NULL
        RETURNING *
      `;
      if (undone.rows.length === 0) {
        return badRequest(res, 'Booking not found or not marked as a no-show');
      }
      return ok(res, { booking: serializeBooking(undone.rows[0], bopts), undone: true });
    }

    // Owner-side ownership check.
    const r = await sql`
      SELECT id, cancelled_at, no_show_at FROM bookings
       WHERE id = ${id} AND workspace_id = ${workspaceId}
       LIMIT 1
    `;
    const b = r.rows[0];
    if (!b) return badRequest(res, 'Booking not found');
    if (b.cancelled_at) return badRequest(res, "Can't mark a cancelled booking as a no-show");
    if (b.no_show_at)   return badRequest(res, 'Already marked as a no-show');

    // Mark first, guarded, so only one request ever goes on to charge.
    const marked = await sql`
      UPDATE bookings SET no_show_at = NOW(), updated_at = NOW()
      WHERE id = ${id} AND workspace_id = ${workspaceId}
        AND no_show_at IS NULL AND cancelled_at IS NULL
      RETURNING id
    `;
    if (marked.rows.length === 0) return badRequest(res, 'Already marked as a no-show');

    // Money stays with the owner: a helper (schedule permission) marks the
    // no-show but never charges the fee. The fee follows the cancellation
    // policy (api/_lib/bookingFees.js): a paid deposit is kept and counts
    // toward the no-show fee; only the rest goes on the card on file. If
    // the card can't be charged the owner is told and a draft invoice for
    // the fee is created.
    const wantCharge = !req.helper && body.chargeFee !== false;
    let result = null;
    if (wantCharge) {
      result = await chargeNoShowFee({ workspaceId, bookingId: id })
        .catch((err) => ({ charged: 0, error: err.message || 'Charge failed' }));
    }
    const upd = await sql`SELECT * FROM bookings WHERE id = ${id} AND workspace_id = ${workspaceId}`;
    const chargedCents = result?.charged || 0;
    const chargeError = result?.error || null;
    const paymentIntentId = chargedCents > 0 ? result.paymentIntent : null;
    const feeAmount = chargedCents / 100;

    return ok(res, {
      booking: serializeBooking(upd.rows[0], bopts),
      charged: !!paymentIntentId,
      chargeAmount: paymentIntentId ? feeAmount : 0,
      chargeError,
      // 1.0.5+: part of the fee covered by the kept deposit, and the draft
      // invoice made when the card could not be charged.
      feeFromDeposit: (result?.fromDeposit || 0) / 100,
      feeInvoice: result?.invoice || null,
    });
  } catch (err) {
    return serverError(res, err);
  }
}
