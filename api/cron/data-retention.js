// Daily: schedule, remind, rescue and run the 7-day data deletion for
// workspaces whose paid subscription has ended. See api/_lib/dataRetention.js.
import { isSuperAdminBySession } from '../_lib/auth.js';
import { runDataRetention } from '../_lib/dataRetention.js';
import { trackCron } from '../_lib/cronMetrics.js';
import { ok, serverError, unauthorized } from '../_lib/json.js';

async function handler(req, res) {
  const cronAuth = !!process.env.CRON_SECRET
    && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
  const adminAuth = process.env.ADMIN_SECRET
    && req.headers['x-admin-secret'] === process.env.ADMIN_SECRET;
  const userAuth = !cronAuth && !adminAuth ? await isSuperAdminBySession(req) : false;
  if (!cronAuth && !adminAuth && !userAuth) return unauthorized(res);
  try {
    const result = await runDataRetention();
    return ok(res, result);
  } catch (err) {
    return serverError(res, err);
  }
}

export default trackCron('data-retention', handler);
