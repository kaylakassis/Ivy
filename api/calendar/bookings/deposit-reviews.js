// /api/calendar/bookings/deposit-reviews   (owner only; helpers never see money)
//   GET  → { reviews: [{ bookingId, clientName, serviceName, date, startMin,
//            amount, currency, reason, requestedAt, cancelledBy }] }
//          The "Deposits to review" list: cancellations whose deposit the
//          policy refunds, waiting for the owner's one tap.
//   POST body { id, decision: 'refund' | 'keep' }
//          refund → runs the deposit refund exactly once (a double tap finds
//                   the request already decided) and emails the receipt
//          keep   → records that the deposit stays, with who and when
import { sql } from '../../_lib/db.js';
import { requireUser } from '../../_lib/auth.js';
import { ensureActiveWorkspace } from '../../_lib/workspaceGate.js';
import { readBody } from '../../_lib/body.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { enforce } from '../../_lib/rate-limit.js';
import { recordWorkspaceAudit } from '../../_lib/audit.js';
import { serializeBooking } from '../../_lib/calendar.js';
import { listDepositReviews, decideDepositRefund } from '../../_lib/bookingFees.js';
import { badRequest, methodNotAllowed, notFound, ok, serverError } from '../../_lib/json.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);
  if (req.method === 'POST' && !requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;

    if (req.method === 'GET') return ok(res, { reviews: await listDepositReviews(workspaceId) });

    if (await enforce(req, res, [{ key: `deposit-decision:ws:${workspaceId}`, max: 120, windowSeconds: 3600 }])) return;
    const body = await readBody(req);
    const id = body?.id ? String(body.id) : '';
    const decision = String(body?.decision || '');
    if (!UUID.test(id)) return badRequest(res, 'id is required');
    if (decision !== 'refund' && decision !== 'keep') return badRequest(res, 'decision must be refund or keep');

    const out = await decideDepositRefund({ workspaceId, bookingId: id, decision, userId: user.id });
    if (out.notFound) return notFound(res, 'Booking not found');
    const row = (await sql`SELECT * FROM bookings WHERE id = ${id} AND workspace_id = ${workspaceId}`).rows[0];
    if (out.alreadyDecided) {
      return ok(res, { booking: serializeBooking(row), alreadyDecided: true, status: out.status });
    }
    if (out.error) return res.status(402).json({ error: out.error, booking: serializeBooking(row) });
    recordWorkspaceAudit(req, {
      workspaceId, actor: user,
      action: decision === 'refund' ? 'booking.deposit_refund_approved' : 'booking.deposit_kept',
      target: { kind: 'booking', id },
      meta: decision === 'refund' ? { amount: (out.refunded || 0) / 100 } : {},
    });
    return ok(res, {
      booking: serializeBooking(row),
      refunded: decision === 'refund' ? (out.refunded || 0) / 100 : 0,
      kept: decision === 'keep',
    });
  } catch (err) {
    return serverError(res, err);
  }
}
