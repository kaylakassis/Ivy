// /api/me/notification-prefs
//   GET   → return the user's notification flags (digest opt-in etc.)
//   PATCH → update one or more flags
//
// Used by /me/settings/notifications AND the owner Settings page.
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { requireSameOrigin } from '../_lib/security.js';
import { readBody } from '../_lib/body.js';
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && !requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    if (req.method === 'GET') {
      const r = await sql`
        SELECT digest_groups_daily, digest_last_sent_at FROM users WHERE id = ${user.id}
      `;
      const row = r.rows[0] || {};
      return ok(res, {
        prefs: {
          digestGroupsDaily: row.digest_groups_daily !== false,
          digestLastSentAt:  row.digest_last_sent_at || null,
        },
      });
    }
    if (req.method === 'PATCH') {
      const body = await readBody(req);
      const sets = [];
      const values = [];
      const push = (col, val) => { values.push(val); sets.push(`${col} = $${values.length}`); };
      if ('digestGroupsDaily' in body) push('digest_groups_daily', !!body.digestGroupsDaily);
      if (sets.length === 0) {
        return ok(res, { prefs: { digestGroupsDaily: true } });
      }
      values.push(user.id);
      const text = `UPDATE users SET ${sets.join(', ')} WHERE id = $${values.length}
                    RETURNING digest_groups_daily, digest_last_sent_at`;
      const r = await sql.query(text, values);
      const row = r.rows[0] || {};
      return ok(res, {
        prefs: {
          digestGroupsDaily: row.digest_groups_daily !== false,
          digestLastSentAt:  row.digest_last_sent_at || null,
        },
      });
    }
    return methodNotAllowed(res, ['GET', 'PATCH']);
  } catch (err) {
    return serverError(res, err);
  }
}
