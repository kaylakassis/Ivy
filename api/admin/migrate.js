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

  const allStatements = splitStatements(SCHEMA_SQL);
  const total = allStatements.length;
  let pending = allStatements.map((stmt, i) => ({ stmt, origIndex: i }));
  let totalApplied = 0;
  let pass = 0;
  let lastFailures = [];
  const MAX_PASSES = 4;

  while (pending.length > 0 && pass < MAX_PASSES) {
    pass++;
    const failures = [];
    for (const { stmt, origIndex } of pending) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await sql.query(stmt);
        totalApplied++;
      } catch (err) {
        failures.push({
          stmt, origIndex,
          message: err.message,
        });
      }
    }
    // eslint-disable-next-line no-console
    console.error(`[migrate] pass ${pass}: applied ${pending.length - failures.length}/${pending.length}; ${failures.length} pending`);
    if (failures.length === pending.length) break; // no progress
    pending = failures.map((f) => ({ stmt: f.stmt, origIndex: f.origIndex }));
    lastFailures = failures;
  }

  const failures = lastFailures.map((f) => ({
    index: f.origIndex + 1,
    of: total,
    message: f.message,
    statement: f.stmt.length > 240 ? f.stmt.slice(0, 240) + '…' : f.stmt,
  }));

  return ok(res, {
    applied: totalApplied,
    total,
    passes: pass,
    failureCount: pending.length,
    failures,
  });
}
