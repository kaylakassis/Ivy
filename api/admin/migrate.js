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

import crypto from 'node:crypto';
import { sql } from '../_lib/db.js';
import { SCHEMA_SQL } from '../_lib/schema.js';
import { splitStatements } from '../_lib/ensureSchema.js';
import { requireSameOrigin } from '../_lib/security.js';
import { requireSuperAdmin, getAdminActor } from '../_lib/admin.js';
import { recordAudit } from '../_lib/audit.js';
import { ok, methodNotAllowed } from '../_lib/json.js';

function hashStmt(s) {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
}

async function loadAlreadyApplied() {
  try {
    const { rows } = await sql`SELECT statement_hash FROM schema_migrations WHERE applied = TRUE`;
    return new Set(rows.map((r) => r.statement_hash));
  } catch {
    // schema_migrations doesn't exist yet on a brand-new DB — caller
    // proceeds with all statements (the first pass will create the
    // table itself).
    return new Set();
  }
}

async function recordStatement({ hash, statement, applied, errorMessage }) {
  try {
    await sql`
      INSERT INTO schema_migrations (
        statement_hash, applied, error_message, statement_preview
      ) VALUES (
        ${hash}, ${applied}, ${errorMessage || null}, ${statement.slice(0, 200)}
      )
      ON CONFLICT (statement_hash) DO UPDATE SET
        applied         = EXCLUDED.applied,
        error_message   = EXCLUDED.error_message,
        last_attempt_at = NOW(),
        apply_count     = schema_migrations.apply_count + 1
    `;
  } catch {
    // Bootstrap window — schema_migrations not yet created. Silent
    // skip; the table will exist after the first successful pass and
    // subsequent runs will record everything.
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  if (!(await requireSuperAdmin(req, res))) return;

  // Audit: migrations are the highest-blast-radius admin action.
  // Recorded BEFORE running so we can correlate failures to the actor.
  const actor = await getAdminActor(req);
  await recordAudit(req, { actor, action: 'admin.migrate', meta: {} });

  const allStatements = splitStatements(SCHEMA_SQL);
  const total = allStatements.length;
  // Load the set of already-applied statement hashes. On a brand-new
  // DB this returns empty (table doesn't exist); after the first
  // successful run it short-circuits unchanged statements so re-runs
  // are O(changed) instead of O(total).
  const alreadyApplied = await loadAlreadyApplied();

  // Tag each statement with its hash up front so we can skip + record
  // consistently below.
  const annotated = allStatements.map((stmt, i) => ({
    stmt, origIndex: i, hash: hashStmt(stmt),
  }));

  let pending = annotated.filter((a) => !alreadyApplied.has(a.hash));
  const skipped = annotated.length - pending.length;

  let totalApplied = 0;
  let pass = 0;
  let lastFailures = [];
  const MAX_PASSES = 4;

  while (pending.length > 0 && pass < MAX_PASSES) {
    pass++;
    const failures = [];
    for (const { stmt, origIndex, hash } of pending) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await sql.query(stmt);
        totalApplied++;
        // eslint-disable-next-line no-await-in-loop
        await recordStatement({ hash, statement: stmt, applied: true });
      } catch (err) {
        failures.push({ stmt, origIndex, hash, message: err.message });
      }
    }
    // eslint-disable-next-line no-console
    console.error(`[migrate] pass ${pass}: applied ${pending.length - failures.length}/${pending.length}; ${failures.length} pending`);
    if (failures.length === pending.length) {
      // No progress this pass — record the stuck failures so admin
      // can see WHY they're stuck, then break.
      for (const f of failures) {
        // eslint-disable-next-line no-await-in-loop
        await recordStatement({
          hash: f.hash, statement: f.stmt,
          applied: false, errorMessage: f.message,
        });
      }
      lastFailures = failures;
      break;
    }
    pending = failures.map((f) => ({ stmt: f.stmt, origIndex: f.origIndex, hash: f.hash }));
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
    skipped,         // statements skipped because their hash was already recorded
    total,
    passes: pass,
    failureCount: pending.length,
    failures,
  });
}
