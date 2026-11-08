// App Store rating prompt (iPhone app, src/lib/ratingPrompt.js).
//
//   GET  /api/me/rating-prompt   { ratingPromptedAt, partner: { onSince, clearedCount } | null }
//        When this user was last shown Apple's rating window from any
//        device, so a reinstall does not ask again inside 120 days; plus
//        the accountability-partner numbers one of the win rules needs
//        (owners only; null for everyone else).
//   POST /api/me/rating-prompt   {}  → { ok: true, ratingPromptedAt }
//        Stamps users.rating_prompted_at = NOW(). Idempotent: calling it
//        twice just moves the stamp forward, which only ever delays the
//        next ask. Owners only: helpers and clients are never asked.
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { requireSameOrigin } from '../_lib/security.js';
import { enforce } from '../_lib/rate-limit.js';
import { forbidden, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export const RATING_INTERVAL_DAYS = 120;

async function ownedWorkspaceId(userId) {
  const { rows } = await sql`SELECT id FROM workspaces WHERE owner_id = ${userId} LIMIT 1`;
  return rows[0]?.id || null;
}

export async function readRatingPrompt(userId, workspaceId) {
  const { rows } = await sql`SELECT rating_prompted_at FROM users WHERE id = ${userId}`;
  const ratingPromptedAt = rows[0]?.rating_prompted_at || null;
  let partner = null;
  if (workspaceId) {
    const [on, cleared] = await Promise.all([
      sql`SELECT MAX(created_at) AS on_since FROM partner_events
           WHERE workspace_id = ${workspaceId} AND user_id = ${userId} AND event = 'turned_on'`,
      sql`SELECT COUNT(*)::int AS n FROM partner_mentions
           WHERE workspace_id = ${workspaceId} AND cleared_at IS NOT NULL`,
    ]);
    const onSince = on.rows[0]?.on_since || null;
    partner = onSince ? { onSince, clearedCount: cleared.rows[0]?.n || 0 } : null;
  }
  return { ratingPromptedAt, partner };
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);
  if (req.method === 'POST' && !requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    if (await enforce(req, res, [{ key: `rating-prompt:user:${user.id}`, max: 60, windowSeconds: 3600 }])) return;
    const workspaceId = await ownedWorkspaceId(user.id);
    if (req.method === 'GET') return ok(res, await readRatingPrompt(user.id, workspaceId));
    if (!workspaceId) return forbidden(res, 'Only business owners are asked to rate the app');
    const { rows } = await sql`
      UPDATE users SET rating_prompted_at = NOW() WHERE id = ${user.id} RETURNING rating_prompted_at`;
    return ok(res, { ok: true, ratingPromptedAt: rows[0]?.rating_prompted_at || null });
  } catch (err) {
    return serverError(res, err);
  }
}
