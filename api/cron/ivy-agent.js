// /api/cron/ivy-agent - the proactive Ivy loop. Per workspace, detect overnight
// signals (overdue invoices, a quiet calendar, a fresh review, waiting leads)
// and store them as PENDING ivy_suggestions the owner acts on in one tap. See
// api/_lib/ivyAgent.js. Idempotent via ivy_suggestions.dedupe_key (per
// owner-local day), so re-running is safe - a signal suggests at most once/day.
//
// Only owners who aren't fully lapsed (trialing/active/past_due) are processed.
// Keyset-paginated + deadline-bounded drain loop so a large account base can't
// blow the function budget. The cursor is per-invocation only - every run
// rescans from the first workspace id - but that's cheap: the per-day
// dedupe keys make an already-processed workspace a fast no-op, so repeat
// runs just skim past them.
import { sql } from '../_lib/db.js';
import { isSuperAdminBySession } from '../_lib/admin.js';
import { trackCron } from '../_lib/cronMetrics.js';
import { runIvyAgentForWorkspace } from '../_lib/ivyAgent.js';
import { ok, serverError, unauthorized } from '../_lib/json.js';
import { withDeadline } from '../_lib/cronShard.js';

const BATCH_SIZE = 100;
const BUDGET_MS = 250_000; // under the api/cron/** 300s function cap

async function handler(req, res) {
  const cronAuth = !!process.env.CRON_SECRET
    && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
  const adminAuth = process.env.ADMIN_SECRET
    && req.headers['x-admin-secret'] === process.env.ADMIN_SECRET;
  const userAuth = !cronAuth && !adminAuth ? await isSuperAdminBySession(req) : false;
  if (!cronAuth && !adminAuth && !userAuth) return unauthorized(res);

  try {
    let scanned = 0, created = 0, batches = 0, complete = false;
    // In-memory batch cursor - resets every invocation (full rescan each
    // run); re-scanned workspaces no-op via the per-day dedupe keys.
    let lastId = '00000000-0000-0000-0000-000000000000';
    await withDeadline(async (deadline) => {
      while (Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop
        const { rows } = await sql`
          SELECT w.id FROM workspaces w
           WHERE w.subscription_status IN ('trialing','active','past_due')
             AND w.id > ${lastId}::uuid
           ORDER BY w.id ASC
           LIMIT ${BATCH_SIZE}`;
        if (rows.length === 0) { complete = true; break; }
        batches += 1;
        for (const r of rows) {
          scanned += 1;
          try {
            // eslint-disable-next-line no-await-in-loop
            const out = await runIvyAgentForWorkspace(r.id);
            created += out.created;
          } catch (err) {
            // eslint-disable-next-line no-console
            console.warn('[ivy-agent] workspace failed', r.id, err.message);
          }
          if (Date.now() >= deadline) break;
        }
        lastId = rows[rows.length - 1].id;
        if (rows.length < BATCH_SIZE) { complete = true; break; }
      }
    }, { budgetMs: BUDGET_MS });

    return ok(res, { scanned, created, batches, complete });
  } catch (err) {
    return serverError(res, err);
  }
}

export default trackCron('ivy-agent', handler);
