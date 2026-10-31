// Program coupon codes (owner only).
//   GET                         → this business's coupons with how often each was used
//   POST  { code, kind: 'percent'|'amount', percentOff? | amountOffCents?,
//           duration: 'once'|'forever', expiresAt?, maxRedemptions?, programId? }
//                               → create (programId blank = every program).
//                                 The matching coupon is created on the
//                                 business's connected payment account when it
//                                 is connected (else on first use at checkout).
//   PATCH { couponId, active: false } → switch a code off (also removed from
//                                 the payment account; subscriptions that
//                                 already use it keep their discount)
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { isUuid } from '../_lib/programs.js';
import { cleanCouponInput, serializeCoupon, ensureStripeCoupon } from '../_lib/programCommerce.js';
import { loadStripeCreds } from '../_lib/stripeCreds.js';
import { stripeFetch } from '../_lib/stripe.js';
import { fetchFinanceSettings } from '../_lib/finance.js';
import { badRequest, created, methodNotAllowed, notFound, ok, serverError } from '../_lib/json.js';

const MAX_COUPONS = 200;

async function listCoupons(workspaceId) {
  const { rows } = await sql`
    SELECT c.*, p.title AS program_title,
           (SELECT COUNT(*)::int FROM program_coupon_redemptions r WHERE r.coupon_id = c.id) AS used
      FROM program_coupons c LEFT JOIN programs p ON p.id = c.program_id
     WHERE c.workspace_id = ${workspaceId}
     ORDER BY c.active DESC, c.created_at DESC LIMIT ${MAX_COUPONS}`;
  return rows.map((c) => serializeCoupon(c, { programTitle: c.program_title || null, used: c.used }));
}

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res); if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res); if (!workspaceId) return;

    if (req.method === 'GET') return ok(res, { coupons: await listCoupons(workspaceId) });

    if (req.method === 'POST') {
      const body = await readBody(req);
      const fin = await fetchFinanceSettings(workspaceId).catch(() => null);
      const v = cleanCouponInput(body, { currency: (fin?.currency || 'USD').toLowerCase() });
      if (v.error) return badRequest(res, v.error);
      const c = v.value;
      if (c.program_id) {
        const p = (await sql`SELECT id FROM programs WHERE id = ${c.program_id} AND workspace_id = ${workspaceId}`).rows[0];
        if (!p) return notFound(res, 'Program not found');
      }
      const n = (await sql`SELECT COUNT(*)::int AS n FROM program_coupons WHERE workspace_id = ${workspaceId} AND active`).rows[0].n;
      if (n >= MAX_COUPONS) return badRequest(res, `You can have up to ${MAX_COUPONS} active codes.`);
      const dup = (await sql`SELECT 1 FROM program_coupons WHERE workspace_id = ${workspaceId} AND code = ${c.code} AND active`).rows[0];
      if (dup) return badRequest(res, 'You already have an active code with that name.');
      let row;
      try {
        row = (await sql`
          INSERT INTO program_coupons (workspace_id, program_id, code, kind, percent_off, amount_off_cents, currency, duration, expires_at, max_redemptions)
          VALUES (${workspaceId}, ${c.program_id}, ${c.code}, ${c.kind}, ${c.percent_off}, ${c.amount_off_cents}, ${c.currency}, ${c.duration}, ${c.expires_at}, ${c.max_redemptions})
          RETURNING *`).rows[0];
      } catch (e) {
        if (e?.code === '23505') return badRequest(res, 'You already have an active code with that name.');
        throw e;
      }
      // Mirror it on the payment account now so it shows in the owner's
      // dashboard. Not connected yet (or a hiccup): checkout creates it later.
      try { const creds = await loadStripeCreds(workspaceId); await ensureStripeCoupon({ coupon: row, creds }); }
      catch { /* created on first use */ }
      return created(res, { coupon: serializeCoupon(row, { used: 0 }), coupons: await listCoupons(workspaceId) });
    }

    if (req.method === 'PATCH') {
      const body = await readBody(req);
      const id = String(body.couponId || '');
      if (!isUuid(id)) return notFound(res, 'Code not found');
      const cur = (await sql`SELECT * FROM program_coupons WHERE id = ${id} AND workspace_id = ${workspaceId}`).rows[0];
      if (!cur) return notFound(res, 'Code not found');
      if (body.active !== false) return badRequest(res, 'A code can be switched off. Create a new one to change it.');
      await sql`UPDATE program_coupons SET active = FALSE, updated_at = NOW() WHERE id = ${id} AND workspace_id = ${workspaceId}`;
      if (cur.stripe_coupon_id) {
        try {
          const creds = await loadStripeCreds(workspaceId);
          if ((creds.stripeAccount || null) === (cur.stripe_account || null)) {
            await stripeFetch(`/coupons/${encodeURIComponent(cur.stripe_coupon_id)}`, { method: 'DELETE', secretKey: creds.secretKey, stripeAccount: creds.stripeAccount });
          }
        } catch { /* already gone, or not reachable: Ivy no longer accepts it either way */ }
      }
      return ok(res, { coupons: await listCoupons(workspaceId) });
    }
    return methodNotAllowed(res, ['GET', 'POST', 'PATCH']);
  } catch (err) { return serverError(res, err); }
}
