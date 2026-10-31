// POST /api/programs/refund   body: { enrollmentId, amountCents?, reason? }
//
// Owner refunds a one-time program purchase through the processor that took
// the payment. Omit amountCents for everything that is left. A full refund
// closes the enrollment (the client's access ends with the money); a
// partial refund records the amount and keeps access, exactly as a refund
// made in the payment dashboard does (shared core in
// api/_lib/purchaseRefunds.js). Owner-only, same-origin, workspace-scoped;
// an amount above what is left is a 400.
//
// Subscription programs (and memberships, which are also provider
// subscriptions) are refused here: a refund of one billing period is made
// against that period's charge in the payment dashboard, where the
// subscription can be cancelled or credited in the same place.
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { refundPurchase } from '../_lib/purchaseRefunds.js';
import { serializeEnrollment } from '../_lib/programs.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
    const body = await readBody(req);
    const id = body.enrollmentId ? String(body.enrollmentId) : null;
    if (!id) return badRequest(res, 'enrollmentId is required');
    let result;
    try {
      result = await refundPurchase({
        workspaceId, kind: 'program', id, amountCents: body.amountCents, reason: body.reason,
        audit: { req, actor: user },
      });
    } catch (e) {
      return badRequest(res, e.message || 'Refund failed');
    }
    const e = (await sql`
      SELECT e.*, c.name AS client_name, c.email AS client_email FROM program_enrollments e
        LEFT JOIN clients c ON c.id = e.client_id
       WHERE e.id = ${id} AND e.workspace_id = ${workspaceId}`).rows[0];
    return ok(res, { ...result, member: serializeEnrollment(e) });
  } catch (err) {
    return serverError(res, err);
  }
}
