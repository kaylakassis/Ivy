// POST /api/admin/migrate — applies the schema embedded in api/_lib/schema.js.
// Protected: requires either x-admin-secret header OR an authenticated
// super-admin session (SUPER_ADMIN_EMAIL match). Re-runs are safe — every
// statement uses IF NOT EXISTS or idempotent UPDATE/INSERT patterns.
//
// Curl:
//   curl -X POST -H "x-admin-secret: $ADMIN_SECRET" https://your-app.vercel.app/api/admin/migrate
//
// In-app: a button in /admin runs this with the user's session.
//
// Surfaces the actual SQL error + the failing statement back to the
// admin caller — this endpoint is super-admin-only, so leaking
// internals is fine and makes debugging schema drift tractable.

import { sql } from '../_lib/db.js';
import { SCHEMA_SQL } from '../_lib/schema.js';
import { splitStatements } from '../_lib/ensureSchema.js';
import { requireSameOrigin } from '../_lib/security.js';
import { requireSuperAdmin } from '../_lib/admin.js';
import { ok, methodNotAllowed } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  if (!(await requireSuperAdmin(req, res))) return;

  const statements = splitStatements(SCHEMA_SQL);

  let applied = 0;
  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i];
    try {
      // eslint-disable-next-line no-await-in-loop
      await sql.query(stmt);
      applied++;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[migrate] statement ${i + 1}/${statements.length} failed:`, err.message);
      // Return enough context for the admin to fix the schema. The
      // 200-char preview avoids dumping a 4kb DO block into the toast.
      return res.status(500).json({
        error:   'Migration failed',
        message: err.message,
        statement: stmt.length > 240 ? stmt.slice(0, 240) + '…' : stmt,
        index:   i + 1,
        of:      statements.length,
        applied,
      });
    }
  }
  return ok(res, { applied, total: statements.length });
}
