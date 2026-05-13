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
  const failures = [];
  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i];
    try {
      // eslint-disable-next-line no-await-in-loop
      await sql.query(stmt);
      applied++;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[migrate] stmt ${i + 1}/${statements.length} failed:`, err.message);
      failures.push({
        index: i + 1,
        of:    statements.length,
        message: err.message,
        // 200-char preview so the response stays small in the UI.
        statement: stmt.length > 240 ? stmt.slice(0, 240) + '…' : stmt,
      });
      // Continue past failures — every statement is idempotent. Bailing
      // on the first error means a single bad statement (e.g. a missing
      // dependency that's added later in the file) blocks every later
      // ADD COLUMN from landing, which is exactly the partial-schema
      // condition behind the recent "Let's go" outage.
    }
  }
  return ok(res, {
    applied,
    total: statements.length,
    failureCount: failures.length,
    failures, // full list so admin can fix offenders
  });
}
