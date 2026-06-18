// GET /api/admin/migrations-history - reports the schema_migrations
// table for the operator: which statements have applied, which are
// stuck, when each was last attempted.
//
// Used to debug "why isn't this new column showing up" by surfacing
// the actual error message + statement preview without grepping
// Vercel function logs.
import { sql } from '../_lib/db.js';
import { requireSameOrigin } from '../_lib/security.js';
import { requireSuperAdmin } from '../_lib/admin.js';
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!requireSameOrigin(req, res)) return;
  if (!(await requireSuperAdmin(req, res))) return;
  try {
    const { rows: summary } = await sql`
      SELECT
        COUNT(*) FILTER (WHERE applied = TRUE)  AS applied,
        COUNT(*) FILTER (WHERE applied = FALSE) AS failed,
        COUNT(*)                                AS total,
        MAX(last_attempt_at)                    AS last_attempt_at
      FROM schema_migrations
    `;

    // Failed statements first (operator wants to see these), then
    // last 50 successful ones for trend visibility.
    const { rows: failed } = await sql`
      SELECT statement_hash, first_applied_at, last_attempt_at,
             apply_count, error_message, statement_preview
      FROM schema_migrations
      WHERE applied = FALSE
      ORDER BY last_attempt_at DESC
      LIMIT 100
    `;
    const { rows: recent } = await sql`
      SELECT statement_hash, first_applied_at, last_attempt_at,
             apply_count, statement_preview
      FROM schema_migrations
      WHERE applied = TRUE
      ORDER BY last_attempt_at DESC
      LIMIT 50
    `;

    return ok(res, {
      summary: summary[0] || { applied: 0, failed: 0, total: 0 },
      failed, recent,
    });
  } catch (err) {
    return serverError(res, err);
  }
}
