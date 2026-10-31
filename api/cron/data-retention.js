// Daily: schedule, remind, rescue and run the 7-day data deletion for
// workspaces whose paid subscription has ended. See api/_lib/dataRetention.js.
import { cronAuthorized } from '../_lib/cronAuth.js';
import { runDataRetention } from '../_lib/dataRetention.js';
import { trackCron } from '../_lib/cronMetrics.js';
import { ok, serverError, unauthorized } from '../_lib/json.js';

async function handler(req, res) {
  if (!(await cronAuthorized(req))) return unauthorized(res);
  try {
    const result = await runDataRetention();
    return ok(res, result);
  } catch (err) {
    return serverError(res, err);
  }
}

export default trackCron('data-retention', handler);
