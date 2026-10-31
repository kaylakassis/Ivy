// POST /api/helper/start-business
//
// "Run your own business?" from the helper shell. A helper's account owns
// nothing, and the owner gate (workspaceGate.js) deliberately refuses to
// mint a workspace for a helper-only account by accident. This is the
// one explicit path: the signed-in user asks for their own business, we
// create the workspace exactly the way signup does for an owner
// (incomplete subscription, card-backed trial starts at the paywall), and
// the app sends them through onboarding. Idempotent: an existing owner
// just gets their workspace id back.
import { sql } from '../_lib/db.js';
import { requireUser, invalidateUserCache } from '../_lib/auth.js';
import { requireSameOrigin } from '../_lib/security.js';
import { invalidateOwnerWorkspace } from '../_lib/clientPortal.js';
import { created, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const owned = await sql`SELECT id FROM workspaces WHERE owner_id = ${user.id} LIMIT 1`;
    if (owned.rows.length > 0) return ok(res, { workspaceId: owned.rows[0].id, created: false });
    let row;
    try {
      const ins = await sql`
        INSERT INTO workspaces (owner_id, subscription_status, trial_ends_at)
        VALUES (${user.id}, 'incomplete', NULL)
        RETURNING id
      `;
      row = ins.rows[0];
    } catch (err) {
      // Lost a race with a concurrent request: read the winner's row.
      const retry = await sql`SELECT id FROM workspaces WHERE owner_id = ${user.id} LIMIT 1`;
      if (retry.rows.length === 0) throw err;
      return ok(res, { workspaceId: retry.rows[0].id, created: false });
    }
    invalidateOwnerWorkspace(user.id);
    invalidateUserCache(user.id);
    return created(res, { workspaceId: row.id, created: true });
  } catch (err) {
    return serverError(res, err);
  }
}
