// POST /api/programs/coupon-check  body: { programId, code }
//
// Public, rate limited. The sales page's "Apply a code": says whether the
// code works on THIS program and what it takes off. Every failure (no such
// code, another program's code, expired, switched off, used up) gets the
// same answer, so the endpoint cannot be used to discover codes. Checkout
// checks the code again; this answer is only for display.
import { sql } from '../_lib/db.js';
import { readBody } from '../_lib/body.js';
import { enforce, getClientIp } from '../_lib/rate-limit.js';
import { isUuid } from '../_lib/programs.js';
import { findValidCoupon, couponDiscountCents, couponLabel, INVALID_CODE } from '../_lib/programCommerce.js';
import { badRequest, methodNotAllowed, notFound, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try {
    const ip = getClientIp(req);
    if (await enforce(req, res, [{ key: `program:cc:${ip}`, max: 20, windowSeconds: 10 * 60 }])) return;
    const body = await readBody(req);
    const programId = String(body.programId || '');
    if (!isUuid(programId)) return notFound(res, 'This program is not available.');
    const p = (await sql`SELECT * FROM programs WHERE id = ${programId} AND status = 'published'`).rows[0];
    if (!p) return notFound(res, 'This program is not available.');
    const fin = (await sql`SELECT currency FROM finance_settings WHERE workspace_id = ${p.workspace_id}`.catch(() => ({ rows: [] }))).rows[0];
    const coupon = await findValidCoupon({ program: p, code: body.code, currency: (fin?.currency || 'USD').toLowerCase() });
    if (!coupon) return badRequest(res, INVALID_CODE);
    const price = Number(p.price_cents) || 0;
    const off = couponDiscountCents(coupon, price);
    return ok(res, {
      valid: true, code: coupon.code, label: couponLabel(coupon), kind: coupon.kind,
      percentOff: coupon.percent_off == null ? null : Number(coupon.percent_off),
      amountOffCents: coupon.amount_off_cents == null ? null : Number(coupon.amount_off_cents),
      duration: p.billing === 'one_time' ? 'once' : coupon.duration,
      discountCents: off, priceAfterCents: Math.max(0, price - off),
    });
  } catch (err) { return serverError(res, err); }
}
