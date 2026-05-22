// /api/review/:token  (public, no auth)
//
//   GET  → fetch the booking summary so the page can render
//          ("Review your massage with Calm Hands on June 4")
//   POST → submit { rating, text? } — creates a reviews row, nulls
//          the token so the link can't be reused
//
// Token mirrors the documents/invoices pattern: the raw token lives
// only in the email link; we store sha256 in bookings.review_request_token_hash.
// Rate-limited per IP since this is anonymous and abuse-prone.
import { sql } from '../_lib/db.js';
import { readBody } from '../_lib/body.js';
import { enforce, getClientIp } from '../_lib/rate-limit.js';
import { badRequest, methodNotAllowed, notFound, ok, serverError } from '../_lib/json.js';
import { ensureSchemaApplied } from '../_lib/ensureSchema.js';
import crypto from 'node:crypto';

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

async function resolve(token) {
  if (typeof token !== 'string' || token.length < 16) return null;
  const tokenHash = hashToken(token);
  const r = await sql`
    SELECT b.id AS booking_id, b.workspace_id, b.client_id, b.client_name,
           b.date, b.start_min, b.end_min, b.cancelled_at,
           s.name AS service_name,
           cs.biz_name, cs.brand_logo_url, cs.brand_accent_color
      FROM bookings b
      LEFT JOIN services s ON s.id = b.service_id AND s.workspace_id = b.workspace_id
      LEFT JOIN calendar_settings cs ON cs.workspace_id = b.workspace_id
     WHERE b.review_request_token_hash = ${tokenHash}
     LIMIT 1
  `;
  return r.rows[0] || null;
}

export default async function handler(req, res) {
  try { await ensureSchemaApplied(); } catch { /* tolerate */ }
  const ip = getClientIp(req);
  const blocked = await enforce(req, res, [
    { key: `review:ip:${ip}`, max: 30, windowSeconds: 60 * 60 },
  ]);
  if (blocked) return;

  try {
    const token = (req.query.token || '').toString();
    const row = await resolve(token);
    if (!row) return notFound(res, "This review link isn't active. It may have already been used or expired.");
    if (row.cancelled_at) return notFound(res, 'That booking was cancelled.');

    if (req.method === 'GET') {
      return ok(res, {
        booking: {
          serviceName:  row.service_name || 'session',
          businessName: row.biz_name || 'the business',
          logoUrl:      row.brand_logo_url || null,
          accentColor:  row.brand_accent_color || null,
          date:         row.date instanceof Date ? row.date.toISOString().slice(0, 10) : row.date,
          startMin:     row.start_min,
          clientName:   row.client_name,
        },
      });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const rating = parseInt(body.rating, 10);
      const text   = (body.text || '').toString().trim().slice(0, 4000) || null;
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        return badRequest(res, 'rating must be 1–5');
      }

      // Insert review. Held as 'pending' for owner moderation — it won't
      // appear publicly until the owner publishes it from the Reviews tab.
      await sql`
        INSERT INTO reviews (
          workspace_id, client_id, booking_id, reviewer_name,
          rating, text, status
        ) VALUES (
          ${row.workspace_id}, ${row.client_id}, ${row.booking_id},
          ${row.client_name || 'Anonymous'},
          ${rating}, ${text}, 'pending'
        )
      `;

      // Invalidate the token so the link can't be reused.
      await sql`
        UPDATE bookings SET
          review_request_token_hash = NULL,
          updated_at = NOW()
        WHERE id = ${row.booking_id}
      `;

      return ok(res, { ok: true });
    }

    return methodNotAllowed(res, ['GET', 'POST']);
  } catch (err) {
    return serverError(res, err);
  }
}
