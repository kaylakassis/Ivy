// GET /api/memberships/members
//
// Owner-side list of every client_memberships row in the workspace,
// with client name/email + tier snapshot for rendering. Powers the
// "Members" view on the Memberships page where the owner can see who
// is on which tier and change a client's plan.
import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { requireSameOrigin } from '../_lib/security.js';
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);

    const { rows } = await sql`
      SELECT cm.id, cm.client_id, cm.membership_id, cm.membership_name,
             cm.price_cents, cm.interval, cm.status,
             cm.current_period_end, cm.cancel_at_period_end,
             cm.started_at, cm.cancelled_at, cm.provider,
             cm.stripe_subscription_id IS NOT NULL AS has_stripe,
             c.name AS client_name, c.email AS client_email
        FROM client_memberships cm
        JOIN clients c ON c.id = cm.client_id AND c.workspace_id = cm.workspace_id
       WHERE cm.workspace_id = ${workspaceId}
       ORDER BY (cm.status = 'active') DESC, cm.started_at DESC
       LIMIT 1000
    `;
    return ok(res, {
      members: rows.map((r) => ({
        id:                r.id,
        clientId:          r.client_id,
        clientName:        r.client_name,
        clientEmail:       r.client_email,
        membershipId:      r.membership_id,
        membershipName:    r.membership_name,
        priceCents:        Number(r.price_cents || 0),
        interval:          r.interval,
        status:            r.status,
        currentPeriodEnd:  r.current_period_end,
        cancelAtPeriodEnd: !!r.cancel_at_period_end,
        startedAt:         r.started_at,
        cancelledAt:       r.cancelled_at,
        provider:          r.provider || 'stripe',
        hasStripe:         !!r.has_stripe,
      })),
    });
  } catch (err) {
    return serverError(res, err);
  }
}
