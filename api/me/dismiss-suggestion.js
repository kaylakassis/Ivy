// POST /api/me/dismiss-suggestion  { signature }
// Records that the owner dismissed an Ivy suggestion (e.g. a proposed
// workflow) so it stops re-appearing. Stored in users.ui_prefs
// .dismissedWorkflowSuggestions (an array of signatures). Small, capped list.
import { sql } from '../_lib/db.js';
import { requireUser, invalidateUserCache } from '../_lib/auth.js';
import { requireSameOrigin } from '../_lib/security.js';
import { readBody } from '../_lib/body.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

const MAX_DISMISSED = 50; // keep the list from growing unbounded

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

    const body = await readBody(req);
    const signature = (body.signature || '').toString().trim().slice(0, 200);
    if (!signature) return badRequest(res, 'signature is required');

    const { rows } = await sql`SELECT ui_prefs FROM users WHERE id = ${user.id}`;
    const current = (rows[0] && rows[0].ui_prefs) || {};
    const prev = Array.isArray(current.dismissedWorkflowSuggestions) ? current.dismissedWorkflowSuggestions : [];
    // Newest last, dedup, cap.
    const next = { ...current, dismissedWorkflowSuggestions: [...new Set([...prev, signature])].slice(-MAX_DISMISSED) };
    await sql`UPDATE users SET ui_prefs = ${JSON.stringify(next)}::jsonb WHERE id = ${user.id}`;
    invalidateUserCache(user.id);
    return ok(res, { dismissed: next.dismissedWorkflowSuggestions });
  } catch (err) {
    return serverError(res, err);
  }
}
