// POST /api/admin/migrate — applies the schema embedded in api/_lib/schema.js.
// Protected: requires either x-admin-secret header OR an authenticated
// super-admin session (SUPER_ADMIN_EMAIL match). Re-runs are safe — every
// statement uses IF NOT EXISTS or idempotent UPDATE/INSERT patterns.
//
// Curl:
//   curl -X POST -H "x-admin-secret: $ADMIN_SECRET" https://your-app.vercel.app/api/admin/migrate
//
// In-app: a button in /account → Admin runs this with the user's session.

import { sql } from '../_lib/db.js';
import { SCHEMA_SQL } from '../_lib/schema.js';
import { requireSameOrigin } from '../_lib/security.js';
import { requireSuperAdmin } from '../_lib/admin.js';
import { ok, methodNotAllowed, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  if (!(await requireSuperAdmin(req, res))) return;

  try {
    const statements = SCHEMA_SQL
      .split(/;\s*\n/)
      .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
      .filter((s) => s.length > 0);

    for (const stmt of statements) {
      // eslint-disable-next-line no-await-in-loop
      await sql.query(stmt);
    }
    return ok(res, { applied: statements.length });
  } catch (err) {
    return serverError(res, err);
  }
}
