// POST /api/invoice-pay/claim  (public, no auth)
//   body { token, method, note? }
//
// The client tapped "I've sent it" on the public invoice page after paying
// through a method no processor handles (Zelle, Venmo, Cash App, cash,
// check). Stamps payment_claimed_* on the invoice and notifies the owner
// (push + email + thread message), at most once per 24h per invoice. A
// second tap updates the method/time quietly. The owner confirms or clears
// it from the invoice drawer. Nothing moves money through Ivy.
//
// Token auth matches /api/invoice-view/:token - the sha256 of the raw view
// token must match a 'sent' or 'overdue' invoice, so a token from one
// workspace can never touch another workspace's rows.
import { sql } from '../_lib/db.js';
import { readBody } from '../_lib/body.js';
import { enforce, getClientIp } from '../_lib/rate-limit.js';
import { recordPaymentClaim, cleanClaimMethod } from '../_lib/paymentClaims.js';
import { badRequest, methodNotAllowed, notFound, ok, serverError } from '../_lib/json.js';
import { ensureSchemaApplied } from '../_lib/ensureSchema.js';
import crypto from 'node:crypto';

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try { await ensureSchemaApplied(); } catch { /* tolerate */ }
  try {
    const ip = getClientIp(req);
    const blocked = await enforce(req, res, [
      { key: `invclaim:ip:${ip}`, max: 10, windowSeconds: 60 * 60 },
    ]);
    if (blocked) return;

    const body = await readBody(req);
    const rawToken = (body.token || req.query?.token || '').toString();
    if (typeof rawToken !== 'string' || rawToken.length < 16) {
      return notFound(res, 'This invoice link is invalid or has expired.');
    }
    const { rows } = await sql`
      SELECT * FROM invoices
      WHERE view_token_hash = ${hashToken(rawToken)}
        AND status IN ('sent', 'overdue')
      LIMIT 1
    `;
    const inv = rows[0];
    if (!inv) return notFound(res, 'This invoice link is invalid, has expired, or was already paid.');

    if (body.method != null && cleanClaimMethod(body.method) !== String(body.method).toLowerCase().trim()) {
      return badRequest(res, 'Unknown payment method');
    }
    const result = await recordPaymentClaim({ inv, method: body.method, note: body.note });
    if (!result) return notFound(res, 'This invoice was already paid - thank you!');

    const biz = await sql`SELECT biz_name FROM calendar_settings WHERE workspace_id = ${inv.workspace_id}`;
    return ok(res, {
      ok: true,
      claimedAt: result.claimedAt,
      method: result.method,
      business: biz.rows[0]?.biz_name || null,
    });
  } catch (err) {
    return serverError(res, err);
  }
}
