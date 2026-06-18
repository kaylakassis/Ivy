// GET /api/public-stats - counts surfaced on the public landing page.
//
// One value for now: total active owners. Edge-cacheable so we don't
// hit Postgres on every cold visitor. No PII; deliberate undercount
// of new accounts within the last 24h to avoid flickering.

import { sql } from './_lib/db.js';
import { methodNotAllowed, ok, serverError } from './_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    // Probe-free; if users table doesn't exist (very cold deploy), zero.
    const { rows } = await sql`
      SELECT COUNT(*)::int AS n
      FROM users
      WHERE created_at <= NOW() - INTERVAL '24 hours'
    `.catch(() => ({ rows: [{ n: 0 }] }));
    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    return ok(res, { owners: rows[0]?.n || 0 });
  } catch (err) {
    return serverError(res, err);
  }
}
