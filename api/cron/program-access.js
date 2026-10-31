// /api/cron/program-access - daily: close one-time program access whose
// window (access_days) has run out. Subscriptions are closed by the Stripe
// webhook; this only handles expires_at. Auth: Vercel cron bearer, or a
// signed-in super-admin poking it by hand.
import { cronAuthorized } from '../_lib/cronAuth.js';
import { expireProgramAccess } from '../_lib/programs.js';
import { ok, serverError, unauthorized } from '../_lib/json.js';
import { trackCron } from '../_lib/cronMetrics.js';

async function handler(req, res) {
  if (!(await cronAuthorized(req))) return unauthorized(res);
  try {
    const expired = await expireProgramAccess();
    return ok(res, { expired });
  } catch (err) { return serverError(res, err); }
}

// Recorded in cron_runs so the hourly operator check can see it ran.
export default trackCron('program-access', handler);
