// POST /api/gift-cards/refund   body: { id, amountCents?, reason? }
//
// Owner refunds a gift card sale through the processor that took the
// payment. Omit amountCents for everything that is left. A full refund
// voids the card; a partial refund trims its balance, the same way a
// refund made in the payment dashboard does (shared core in
// api/_lib/purchaseRefunds.js). Owner-only, same-origin, workspace-scoped;
// an amount above what is left is a 400.
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { refundPurchase } from '../_lib/purchaseRefunds.js';
import { serializeGiftCard } from '../_lib/giftCards.js';
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
    let result;
    try {
      result = await refundPurchase({
        workspaceId, kind: 'gift_card', id, amountCents: body.amountCents, reason: body.reason,
        audit: { req, actor: user },
      });
    } catch (e) {
      return badRequest(res, e.message || 'Refund failed');
    }
    const card = (await sql`SELECT * FROM gift_cards WHERE id = ${id} AND workspace_id = ${workspaceId}`).rows[0];
    return ok(res, { ...result, card: serializeGiftCard(card) });
  } catch (err) {
    return serverError(res, err);
  }
}
