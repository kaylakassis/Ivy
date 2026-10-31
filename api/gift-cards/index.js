// GET /api/gift-cards - owner-side list of issued cards.
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { requireSameOrigin } from '../_lib/security.js';
import { serializeGiftCard } from '../_lib/giftCards.js';
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
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
        -- Money that came off cards at bookings. Refunds also lower the
        -- balance (and void the card), so they are taken out here or a
        -- refunded card would read as "redeemed".
        COALESCE(SUM(GREATEST(0, original_amount_cents - balance_cents - refunded_cents)), 0)::bigint AS redeemed_cents,
        COALESCE(SUM(refunded_cents), 0)::bigint AS refunded_cents
      FROM gift_cards
      WHERE workspace_id = ${workspaceId}
    `;
    // Where the money went: redemptions at bookings vs on invoices, so the
    // tab can say "applied to 4 bookings and 2 invoices".
    const reds = await sql`
      SELECT applied_to_kind AS kind, COUNT(*)::int AS n, COALESCE(SUM(amount_cents), 0)::bigint AS cents
        FROM gift_card_redemptions WHERE workspace_id = ${workspaceId} GROUP BY applied_to_kind
    `;
    const byKind = Object.fromEntries(reds.rows.map((x) => [x.kind, { count: Number(x.n || 0), cents: Number(x.cents || 0) }]));
    return ok(res, {
      cards: r.rows.map(serializeGiftCard),
      redemptions: {
        bookings: byKind.booking || { count: 0, cents: 0 },
        invoices: byKind.invoice || { count: 0, cents: 0 },
      },
      summary: {
        total:           Number(agg.rows[0]?.total || 0),
        issuedCents:     Number(agg.rows[0]?.issued_cents || 0),
        outstandingCents: Number(agg.rows[0]?.outstanding_cents || 0),
        redeemedCents:   Number(agg.rows[0]?.redeemed_cents || 0),
        refundedCents:   Number(agg.rows[0]?.refunded_cents || 0),
      },
    });
  } catch (err) {
    return serverError(res, err);
  }
}
