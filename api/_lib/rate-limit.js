// Postgres-backed sliding-window rate limiter.
// Counts recent attempts for a key; if under the limit, records a new attempt.
// Cheap to operate at our scale (single SELECT count + single INSERT per request).
import { sql } from './db.js';

export async function rateLimit({ key, max, windowSeconds }) {
  const since = new Date(Date.now() - windowSeconds * 1000).toISOString();
  const { rows } = await sql`
    SELECT COUNT(*)::int AS n
    FROM rate_limits
    WHERE key = ${key} AND attempted_at > ${since}
  `;
  const n = rows[0].n;
  if (n >= max) {
    return { allowed: false, count: n, retryAfterSeconds: windowSeconds };
  }
  await sql`INSERT INTO rate_limits (key, attempted_at) VALUES (${key}, NOW())`;
  return { allowed: true, count: n + 1 };
}

// Best-effort client IP from x-forwarded-for (Vercel sets this).
export function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  if (req.headers['x-real-ip']) return String(req.headers['x-real-ip']);
  return req.socket?.remoteAddress || 'unknown';
}

// Convenience: enforce one or more limits in sequence; sends 429 + returns true if blocked.
//
// Super-admins skip the limiter entirely so manual testing / repeated
// password-reset triggers don't lock them out of their own product.
// Admin auth is detected via x-admin-secret header OR a session belonging
// to an allowlisted email — same paths as requireSuperAdmin.
export async function enforce(req, res, limits) {
  if (await isAdminBypass(req)) return false;

  for (const limit of limits) {
    const r = await rateLimit(limit);
    if (!r.allowed) {
      res.setHeader('Retry-After', String(r.retryAfterSeconds));
      res.status(429).json({
        error: 'Too many attempts. Please wait and try again.',
        retryAfterSeconds: r.retryAfterSeconds,
      });
      return true;
    }
  }
  return false;
}

// Lazy import to avoid the rate limiter pulling in admin.js (which
// imports auth.js → rate-limit.js circular).
async function isAdminBypass(req) {
  try {
    const secret = process.env.ADMIN_SECRET;
    if (secret && req?.headers?.['x-admin-secret'] === secret) return true;
    const { isSuperAdminBySession } = await import('./admin.js');
    return await isSuperAdminBySession(req);
  } catch {
    return false;
  }
}
