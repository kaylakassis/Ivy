// POST /api/gift-cards/check (public, no auth)
//   body: { slug, code }
//
// Returns a public summary (balance + last4 + status) for a gift
// card the visitor wants to apply to a booking. Rate-limited per
// IP — anonymous brute-force protection.
//
// Never returns the full code (we don't have it — only the hash).
// Never reveals card existence to other workspaces.
import { sql } from '../_lib/db.js';
import { readBody } from '../_lib/body.js';
import { enforce, getClientIp } from '../_lib/rate-limit.js';
import { findActiveByCode } from '../_lib/giftCards.js';
import { badRequest, methodNotAllowed, notFound, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try {
    const ip = getClientIp(req);
    const blocked = await enforce(req, res, [
      { key: `gc-check:ip:${ip}`, max: 30, windowSeconds: 60 * 60 },
    ]);
    if (blocked) return;

    const body = await readBody(req);
    const slug = (body.slug || '').toString().toLowerCase().trim();
    const code = (body.code || '').toString();
    if (!slug) return badRequest(res, 'slug is required');
    if (!code) return badRequest(res, 'code is required');

    const cs = await sql`SELECT workspace_id FROM calendar_settings WHERE slug = ${slug}`;
    if (cs.rows.length === 0) return notFound(res, 'No business with that handle');
    const card = await findActiveByCode(cs.rows[0].workspace_id, code);
    if (!card) return notFound(res, 'Gift card not found or already used');

    return ok(res, {
      card: {
        codeLast4: card.code_last4,
        balanceCents: Number(card.balance_cents || 0),
        expiresAt: card.expires_at,
      },
    });
  } catch (err) {
    return serverError(res, err);
  }
}
