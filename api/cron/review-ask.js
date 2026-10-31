// Daily: send the weekly "Loving Ivy?" check-in push to owners who are due
// one. Per-owner cadence lives in api/_lib/reviewPrompt.js.
import { isSuperAdminBySession } from '../_lib/admin.js';
import { sendReviewPrompts } from '../_lib/reviewPrompt.js';
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
    return ok(res, await sendReviewPrompts());
  } catch (err) {
    return serverError(res, err);
  }
}

export default trackCron('review-ask', handler);
