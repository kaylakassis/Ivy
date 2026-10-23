// GET   /api/finance/manual-methods
//   The owner's list of ways to get paid outside a processor (Zelle,
//   Venmo, Cash App, cash, check). Shape:
//   { methods: [{ type, handle, note, enabled }] }
//
// PATCH /api/finance/manual-methods  body { methods: [...] }
//   Replaces the list. Validated server-side: known types only, handle
//   120 chars max, note 300 chars max, at most 6 entries, and a handle is
//   required when Zelle / Venmo / Cash App is switched on (there is
//   nothing for the client to send to otherwise).
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { normalizeManualMethods } from '../_lib/finance.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

async function load(workspaceId) {
  const r = await sql`SELECT manual_methods FROM finance_settings WHERE workspace_id = ${workspaceId}`;
  return Array.isArray(r.rows[0]?.manual_methods) ? r.rows[0].manual_methods : [];
}

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;

    if (req.method === 'GET') {
      return ok(res, { methods: await load(workspaceId) });
    }

    if (req.method === 'PATCH') {
      const body = await readBody(req);
      let methods;
      try {
        methods = normalizeManualMethods(body.methods);
      } catch (e) {
        return badRequest(res, e.message);
      }
      await sql`
        INSERT INTO finance_settings (workspace_id, manual_methods)
        VALUES (${workspaceId}, ${JSON.stringify(methods)}::jsonb)
        ON CONFLICT (workspace_id) DO UPDATE SET manual_methods = EXCLUDED.manual_methods
      `;
      return ok(res, { methods });
    }

    return methodNotAllowed(res, ['GET', 'PATCH']);
  } catch (err) {
    return serverError(res, err);
  }
}
