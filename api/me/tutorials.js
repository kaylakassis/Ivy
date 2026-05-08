// /api/me/tutorials
//   GET   → returns the signed-in user's tutorials_completed map
//   PATCH → marks one tab's tutorial as completed or skipped
//           body: { tabId, status: 'completed' | 'skipped' }
//
// We don't differentiate "completed" from "skipped" for auto-trigger
// purposes — both stop the tab from auto-opening the tutorial again.
// We DO record which it was so we can later report completion-rate
// stats and identify tabs people consistently skip.
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

const VALID_STATUS = new Set(['completed', 'skipped']);
const TAB_ID_RE = /^[a-z][a-z0-9_-]{0,40}$/;

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    if (req.method === 'GET') {
      const r = await sql`SELECT tutorials_completed FROM users WHERE id = ${user.id}`;
      return ok(res, { tutorials: r.rows[0]?.tutorials_completed || {} });
    }

    if (req.method === 'PATCH') {
      const body = await readBody(req);
      const tabId = (body.tabId || '').toString();
      const status = (body.status || 'completed').toString();
      if (!TAB_ID_RE.test(tabId)) return badRequest(res, 'Invalid tabId');
      if (!VALID_STATUS.has(status)) return badRequest(res, 'Invalid status');
      // jsonb_set merges the single key in-place; no read-modify-write
      // race when two tabs are dismissed in quick succession.
      const r = await sql`
        UPDATE users SET
          tutorials_completed = jsonb_set(
            COALESCE(tutorials_completed, '{}'::jsonb),
            ${'{' + tabId + '}'}::text[],
            to_jsonb(${status}::text),
            true
          )
        WHERE id = ${user.id}
        RETURNING tutorials_completed
      `;
      return ok(res, { tutorials: r.rows[0]?.tutorials_completed || {} });
    }

    return methodNotAllowed(res, ['GET', 'PATCH']);
  } catch (err) {
    return serverError(res, err);
  }
}
