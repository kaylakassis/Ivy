// Postgres-backed sliding-window rate limiter.
// Counts recent attempts for a key; if under the limit, records a new attempt.
// Cheap to operate at our scale (single SELECT count + single INSERT per request).
import { createHash, timingSafeEqual } from 'node:crypto';
import { sql } from './db.js';

export async function rateLimit({ key, max, windowSeconds }) {
  const since = new Date(Date.now() - windowSeconds * 1000).toISOString();
  try {
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
  } catch (err) {
    // The DB-backed limiter must NEVER fail open: a DB blip during a traffic
    // spike is exactly when brute-force / spam protection matters most. Fall
    // back to a per-instance in-memory window so throttling degrades
    // gracefully (best-effort across lambda instances) instead of vanishing.
    // eslint-disable-next-line no-console
    console.error('[rate-limit] DB unavailable, using in-memory fallback:', err.message);
    return memRateLimit({ key, max, windowSeconds });
  }
}

// Failure-only counting for sign-in. countRecent says how many times a key
// was recorded in the window and when the oldest of those was (so a
// lock message can say how many minutes remain); recordAttempt adds one.
// Both fall back to the in-memory window if the database is unreachable,
// same as rateLimit above - a DB blip must not disable the lock.
export async function countRecent(key, windowSeconds) {
  const since = new Date(Date.now() - windowSeconds * 1000).toISOString();
  try {
    const { rows } = await sql`
      SELECT COUNT(*)::int AS n, MIN(attempted_at) AS oldest
        FROM rate_limits
       WHERE key = ${key} AND attempted_at > ${since}
    `;
    return { count: rows[0].n, oldestAt: rows[0].oldest ? new Date(rows[0].oldest).getTime() : null };
  } catch {
    const cutoff = Date.now() - windowSeconds * 1000;
    const hits = (memHits.get(key) || []).filter((t) => t > cutoff);
    return { count: hits.length, oldestAt: hits.length ? Math.min(...hits) : null };
  }
}
export async function recordAttempt(key) {
  try { await sql`INSERT INTO rate_limits (key, attempted_at) VALUES (${key}, NOW())`; }
  catch {
    const hits = memHits.get(key) || [];
    hits.push(Date.now());
    if (!memHits.has(key) && memHits.size >= MEM_MAX_KEYS) memHits.delete(memHits.keys().next().value);
    memHits.set(key, hits);
  }
}

// A successful sign-in proves the person is who they say they are, so the
// attempts that led up to it should not count against them. Without this,
// signing in on a phone, a laptop and a private window in one hour locked
// the owner out of her own product with the right password.
export async function clearRateLimit(key) {
  try { await sql`DELETE FROM rate_limits WHERE key = ${key}`; } catch { /* best effort */ }
  memHits.delete(key);
}

// Forgive only the most recent attempt for a key (the one this successful
// request just recorded), leaving any genuine failures counted.
export async function forgiveLastAttempt(key) {
  try {
    await sql`
      DELETE FROM rate_limits
       WHERE ctid = (SELECT ctid FROM rate_limits WHERE key = ${key} ORDER BY attempted_at DESC LIMIT 1)
    `;
  } catch { /* best effort */ }
  const hits = memHits.get(key);
  if (hits?.length) hits.pop();
}

// Per-process sliding-window fallback. Bounded so a DB outage can't grow it
// without limit (oldest keys are evicted past MEM_MAX_KEYS).
const memHits = new Map(); // key -> number[] (ms timestamps)
const MEM_MAX_KEYS = 10000;

export function memRateLimit({ key, max, windowSeconds }) {
  const now = Date.now();
  const cutoff = now - windowSeconds * 1000;
  const recent = (memHits.get(key) || []).filter((t) => t > cutoff);
  if (recent.length >= max) {
    memHits.set(key, recent);
    return { allowed: false, count: recent.length, retryAfterSeconds: windowSeconds };
  }
  recent.push(now);
  memHits.set(key, recent);
  if (memHits.size > MEM_MAX_KEYS) {
    // Drop the oldest-inserted keys (Map preserves insertion order).
    for (const k of memHits.keys()) {
      memHits.delete(k);
      if (memHits.size <= MEM_MAX_KEYS) break;
    }
  }
  return { allowed: true, count: recent.length };
}

// Trusted client IP. The leftmost x-forwarded-for entry is NOT safe to
// trust: Vercel appends to a client-supplied XFF, so an attacker can
// prepend a fake IP to dodge per-IP rate limits (login/signup/booking
// spam). Prefer the headers Vercel sets at the edge - clients cannot
// override the x-vercel-* prefix or x-real-ip - and only fall back to the
// LAST x-forwarded-for hop (added by the closest trusted proxy) rather
// than the spoofable first.
export function getClientIp(req) {
  const h = req.headers || {};
  const first = (v) => String(v).split(',')[0].trim();
  if (h['x-vercel-forwarded-for']) return first(h['x-vercel-forwarded-for']);
  if (h['x-real-ip']) return first(h['x-real-ip']);
  const xff = h['x-forwarded-for'];
  if (xff) {
    const parts = String(xff).split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return req.socket?.remoteAddress || 'unknown';
}

// Convenience: enforce one or more limits in sequence; sends 429 + returns true if blocked.
//
// Super-admins skip the limiter entirely so manual testing / repeated
// password-reset triggers don't lock them out of their own product.
// Admin auth is detected via x-admin-secret header OR a session belonging
// to an allowlisted email - same paths as requireSuperAdmin.
export async function enforce(req, res, limits) {
  if (await isAdminBypass(req)) return false;

  for (const limit of limits) {
    const r = await rateLimit(limit);
    if (!r.allowed) {
      res.setHeader('Retry-After', String(r.retryAfterSeconds));
      const mins = Math.max(1, Math.ceil(r.retryAfterSeconds / 60));
      res.status(429).json({
        error: mins >= 60
          ? 'Too many attempts. Please wait about an hour and try again.'
          : `Too many attempts. Please wait about ${mins} minute${mins === 1 ? '' : 's'} and try again.`,
        retryAfterSeconds: r.retryAfterSeconds,
      });
      return true;
    }
  }
  return false;
}

// Lazy import to avoid the rate limiter pulling in admin.js (which
// imports auth.js → rate-limit.js circular).
export async function isAdminBypass(req) {
  try {
    const secret = process.env.ADMIN_SECRET;
    const provided = req?.headers?.['x-admin-secret'];
    if (secret && typeof provided === 'string' && secretsMatch(provided, secret)) return true;
    const { isSuperAdminBySession } = await import('./admin.js');
    return await isSuperAdminBySession(req);
  } catch {
    return false;
  }
}

// Constant-time secret compare, same as admin.js's secretsMatch (copied
// rather than imported to preserve the lazy-import decoupling above). Hash
// both sides to a fixed 32 bytes first so timingSafeEqual gets equal-length
// buffers and the comparison never leaks length or content via early-exit
// timing - a plain === here let an attacker recover ADMIN_SECRET byte-by-
// byte against the very endpoint the limiter protects.
function secretsMatch(provided, expected) {
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}
