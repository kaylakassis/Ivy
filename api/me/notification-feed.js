// /api/me/notification-feed
//   GET   → recent notifications + unread count for the bell badge
//   POST  → mark read. Body: { ids?: string[] }  empty/missing = all
//
// Distinct from /api/me/notifications.js, which manages per-type
// PUSH/EMAIL preferences (the toggle list on /account). This is the
// feed surface - the bell icon + dropdown in the topbar.
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { requireSameOrigin } from '../_lib/security.js';
import { readBody } from '../_lib/body.js';
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';

const LIST_LIMIT = 50;

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    if (req.method === 'GET') {
      // Hard cap so a runaway notification spammer can't blow up the
      // payload. 50 covers the common "last few days" window - older
      // rows are still in the table for audit but the bell only
      // surfaces the recent slice. db-prune trims > 60 days.
      const { rows } = await sql`
        SELECT id, workspace_id, type, title, body, url, tag, read_at, created_at
          FROM notifications
         WHERE user_id = ${user.id}
         ORDER BY created_at DESC
         LIMIT ${LIST_LIMIT}
      `;
      // Unread count is the metric the bell badge displays; we count
      // independently of the listed slice so e.g. 150 unread reads as
      // "99+" rather than capping at LIST_LIMIT.
      const unreadResult = await sql`
        SELECT COUNT(*)::int AS n
          FROM notifications
         WHERE user_id = ${user.id} AND read_at IS NULL
      `;
      const unread = unreadResult.rows[0]?.n ?? 0;
      return ok(res, {
        notifications: rows.map((r) => ({
          id:          r.id,
          workspaceId: r.workspace_id,
          type:        r.type,
          title:       r.title,
          body:        r.body,
          url:         r.url,
          tag:         r.tag,
          readAt:      r.read_at,
          createdAt:   r.created_at,
        })),
        unread,
        cap: LIST_LIMIT,
      });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const idsRaw = Array.isArray(body?.ids) ? body.ids : null;
      if (idsRaw && idsRaw.length > 0) {
        // Cap input length so a giant array can't blow the query.
        const ids = idsRaw.slice(0, 200).map(String);
        await sql.query(
          `UPDATE notifications SET read_at = NOW()
             WHERE user_id = $1 AND id = ANY($2) AND read_at IS NULL`,
          [user.id, ids],
        );
      } else {
        // Mark-all-read.
        await sql`
          UPDATE notifications SET read_at = NOW()
           WHERE user_id = ${user.id} AND read_at IS NULL
        `;
      }
      return ok(res, { ok: true });
    }

    return methodNotAllowed(res, ['GET', 'POST']);
  } catch (err) {
    return serverError(res, err);
  }
}
