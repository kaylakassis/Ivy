// GET /api/gift-cards — owner-side list of issued cards.
import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { requireActiveSubscription } from '../_lib/subscriptionGate.js';
import { requireSameOrigin } from '../_lib/security.js';
import { serializeGiftCard } from '../_lib/giftCards.js';
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);
    if (req.method !== 'GET' && req.method !== 'HEAD' && !(await requireActiveSubscription(workspaceId, req, res))) return;

    const r = await sql`
      SELECT * FROM gift_cards
       WHERE workspace_id = ${workspaceId}
       ORDER BY created_at DESC
       LIMIT 500
    `;
    // Aggregate snapshot for the dashboard top strip.
    const agg = await sql`
      SELECT
        COUNT(*)::int AS total,
        COALESCE(SUM(original_amount_cents), 0)::bigint AS issued_cents,
        COALESCE(SUM(balance_cents), 0)::bigint AS outstanding_cents,
        COALESCE(SUM(original_amount_cents - balance_cents), 0)::bigint AS redeemed_cents
      FROM gift_cards
      WHERE workspace_id = ${workspaceId}
    `;
    return ok(res, {
      cards: r.rows.map(serializeGiftCard),
      summary: {
        total:           Number(agg.rows[0]?.total || 0),
        issuedCents:     Number(agg.rows[0]?.issued_cents || 0),
        outstandingCents: Number(agg.rows[0]?.outstanding_cents || 0),
        redeemedCents:   Number(agg.rows[0]?.redeemed_cents || 0),
      },
    });
  } catch (err) {
    return serverError(res, err);
  }
}
