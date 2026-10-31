// /api/cron/program-checkins - hourly: on the day a program check-in is
// due, from 9am in the business's timezone, members who have not filled it
// in yet get one reminder (email + push; several forms in one program share
// it). Sends are claimed in program_notifications, so each member hears
// about each form at most once per period however often this runs.
// Auth: Vercel cron bearer, or a signed-in super-admin poking it by hand.
import { cronAuthorized } from '../_lib/cronAuth.js';
import { runCheckinReminders } from '../_lib/programCheckinNotify.js';
import { ok, serverError, unauthorized } from '../_lib/json.js';
import { trackCron } from '../_lib/cronMetrics.js';

async function handler(req, res) {
  if (!(await cronAuthorized(req))) return unauthorized(res);
  try {
    return ok(res, await runCheckinReminders());
  } catch (err) { return serverError(res, err); }
}

export default trackCron('program-checkins', handler);
