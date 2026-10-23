// POST /api/invoices/clear-claim  body: { id, message? }
// The owner looked for the money the client said they sent and it is not
// there. Clears payment_claimed_* so the drawer banner goes away and the
// client can tap "I've sent it" again later. An optional message goes to
// the client's thread from the business.
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { fetchOwnedInvoice, serializeInvoice } from '../_lib/finance.js';
import { clearPaymentClaim } from '../_lib/paymentClaims.js';
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
    const id = body.id ? String(body.id) : null;
    if (!id) return badRequest(res, 'id is required');

    const inv = await fetchOwnedInvoice({ id, workspaceId });
    if (!inv) return badRequest(res, 'Invoice not found');
    if (!inv.payment_claimed_at) return ok(res, { invoice: serializeInvoice(inv), noop: true });

    const row = await clearPaymentClaim({ inv, workspaceId, message: body.message });
    return ok(res, { invoice: serializeInvoice(row || inv) });
  } catch (err) {
    return serverError(res, err);
  }
}
