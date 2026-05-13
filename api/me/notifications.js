// /api/me/notifications
//   GET   → current per-type push prefs (missing keys default to enabled)
//   PATCH → update one or more keys. Body: { prefs: { messages: false, ... } }
//
// Mirrors the toggle list in /account → Notifications. Adding a new type
// is a one-line change to NOTIFY_TYPES in api/_lib/push.js plus a
// corresponding row in the UI — no schema migration.
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { NOTIFY_TYPES } from '../_lib/push.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    if (req.method === 'GET') {
      let stored = {};
      try {
        const r = await sql`SELECT notification_prefs FROM users WHERE id = ${user.id}`;
        stored = r.rows[0]?.notification_prefs || {};
      } catch (e) {
        // notification_prefs column missing — fall back to defaults so
        // the account page can still render notification settings.
        // eslint-disable-next-line no-console
        console.error('[me/notifications GET] failed (using defaults):', e.message);
      }
      const prefs = {};
      for (const t of NOTIFY_TYPES) prefs[t] = stored[t] !== false;
      return ok(res, { prefs, types: NOTIFY_TYPES });
    }

    if (req.method === 'PATCH') {
      const body = await readBody(req);
      const incoming = body && typeof body.prefs === 'object' ? body.prefs : null;
      if (!incoming) return badRequest(res, 'prefs is required');

      // Whitelist: only types we know about land in the JSON. Anything
      // else is dropped silently.
      const r = await sql`SELECT notification_prefs FROM users WHERE id = ${user.id}`;
      const next = { ...(r.rows[0]?.notification_prefs || {}) };
      for (const t of NOTIFY_TYPES) {
        if (t in incoming) next[t] = !!incoming[t];
      }
      await sql`
        UPDATE users SET notification_prefs = ${JSON.stringify(next)}::jsonb
        WHERE id = ${user.id}
      `;
      // Echo the resolved set so the UI can sync without a follow-up GET.
      const out = {};
      for (const t of NOTIFY_TYPES) out[t] = next[t] !== false;
      return ok(res, { prefs: out, types: NOTIFY_TYPES });
    }

    return methodNotAllowed(res, ['GET', 'PATCH']);
  } catch (err) {
    return serverError(res, err);
  }
}
