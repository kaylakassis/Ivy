// /api/cron/workflows - hourly job. Two responsibilities:
//
//   1. evaluateScheduledWorkflows - walks every enabled time-based
//      workflow (client_inactive, booking_completed) and fires matching
//      clients/bookings. Once-a-day per match is plenty for these.
//
//   2. resumeWaitingWorkflows - picks up workflow_pending_runs rows
//      whose resume_at has passed (a prior `wait` action queued them)
//      and resumes execution from the saved action index.
//
// Inline triggers (lead_created, client_created) don't run through
// here - they fire from inside their source endpoints synchronously.
//
// Schedule: hourly so a 1h-precision `wait` step doesn't drift more
// than 59m. Time-based-trigger evaluation re-runs hourly too but the
// per-client-per-day dedupe inside the workflow run prevents duplicate
// fires.
//
// Auth: same pattern as the other cron jobs - Authorization: Bearer
// $CRON_SECRET from Vercel cron, x-admin-secret for manual testing,
// or a super-admin session for the "Run now" button in /admin.
import { evaluateScheduledWorkflows, resumeWaitingWorkflows } from '../_lib/workflows.js';
import { autoCompleteSmartTasks } from '../_lib/goals.js';
import { isSuperAdminBySession } from '../_lib/admin.js';
import { ok, serverError, unauthorized } from '../_lib/json.js';
import { ensureSchemaApplied } from '../_lib/ensureSchema.js';
import { trackCron } from '../_lib/cronMetrics.js';
import { shardFromReq, shardClause, withDeadline } from '../_lib/cronShard.js';

async function handler(req, res) {
  const cronAuth = !!process.env.CRON_SECRET
    && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
  const adminAuth = !!process.env.ADMIN_SECRET
    && (req.headers['x-admin-secret'] === process.env.ADMIN_SECRET);
  const userAuth = !cronAuth && !adminAuth ? await isSuperAdminBySession(req) : false;
  if (!cronAuth && !adminAuth && !userAuth) return unauthorized(res);

  try {
    await ensureSchemaApplied();

    const { shard, shards } = shardFromReq(req);
    // evaluateScheduledWorkflows selects from `workflows` unaliased;
    // resumeWaitingWorkflows aliases it `w`. Same workspace_id hash, so
    // a given workspace's scheduled fires AND its pending resumes land
    // on the same shard — no cross-shard double-processing.
    const evalFilter   = shardClause({ shard, shards }, 'workspace_id');
    const resumeFilter = shardClause({ shard, shards }, 'w.workspace_id');

    let scheduled = { fired: 0, evaluated: 0, workflows: 0 };
    let resumed = { resumed: 0 };
    await withDeadline(async (deadline) => {
      scheduled = await evaluateScheduledWorkflows({ shardFilter: evalFilter, deadline });
      // prune only on shard 0 so a fan-out doesn't race the global
      // >7d cleanup DELETE.
      resumed = await resumeWaitingWorkflows({ shardFilter: resumeFilter, prune: shard === 0 });
    });

    // Flip "smart" tasks whose triggering activity has occurred (message
    // sent / invoice sent / document sent) to done. Global + idempotent,
    // so run it on a single shard to avoid redundant full-table work.
    const autoTasks = (shard === 0)
      ? await autoCompleteSmartTasks().catch((e) => {
          // eslint-disable-next-line no-console
          console.error('[cron/workflows] autoCompleteSmartTasks failed:', e.message);
          return 0;
        })
      : 0;
    return ok(res, {
      shard, shards,
      fired: scheduled.fired,
      workflowsEvaluated: scheduled.evaluated,
      workflowsTotal: scheduled.workflows,
      resumed: resumed.resumed,
      autoCompletedTasks: autoTasks,
    });
  } catch (err) {
    return serverError(res, err);
  }
}

export default trackCron('workflows', handler);
