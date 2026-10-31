// /api/cron/program-drip - daily: tell members when a dripped module
// opened for them (email + push, once per member per module; several
// modules opening the same day share one message), and in cohort
// programs when their cohort starts. Sends are recorded in
// program_notifications, so a second run the same day sends nothing.
// Auth: Vercel cron bearer, or a signed-in super-admin poking it by hand.
import { cronAuthorized } from '../_lib/cronAuth.js';
import { runDripNotifications, runCohortStartNotifications } from '../_lib/programNotify.js';
import { ok, serverError, unauthorized } from '../_lib/json.js';
import { trackCron } from '../_lib/cronMetrics.js';

async function handler(req, res) {
  if (!(await cronAuthorized(req))) return unauthorized(res);
  try {
    const result = await runDripNotifications();
    const cohorts = await runCohortStartNotifications();
    return ok(res, { ...result, cohorts });
  } catch (err) { return serverError(res, err); }
}

// Recorded in cron_runs so the hourly operator check can see it ran.
export default trackCron('program-drip', handler);
