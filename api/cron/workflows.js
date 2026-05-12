// /api/cron/workflows — daily job. Walks every enabled workflow whose
// trigger_type is time-based (client_inactive, booking_completed) and
// fires it for matching clients/bookings.
//
// Inline triggers (lead_created, client_created) don't run through
// here — they fire from inside their source endpoints synchronously.
//
// Auth: same pattern as the other cron jobs — Authorization: Bearer
// $CRON_SECRET from Vercel cron, x-admin-secret for manual testing,
// or a super-admin session for the "Run now" button in /admin.
//
// Schedule: once a day at 13:00 UTC (configured in vercel.json). At
// most ~500 fires per invocation — anything bigger waits for tomorrow.
import { evaluateScheduledWorkflows } from '../_lib/workflows.js';
import { isSuperAdminBySession } from '../_lib/admin.js';
import { ok, serverError, unauthorized } from '../_lib/json.js';

export default async function handler(req, res) {
  const cronAuth = !!process.env.CRON_SECRET
    && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
  const adminAuth = !!process.env.ADMIN_SECRET
    && (req.headers['x-admin-secret'] === process.env.ADMIN_SECRET);
  const userAuth = !cronAuth && !adminAuth ? await isSuperAdminBySession(req) : false;
  if (!cronAuth && !adminAuth && !userAuth) return unauthorized(res);

  try {
    const out = await evaluateScheduledWorkflows({ limit: 500 });
    return ok(res, { fired: out.fired });
  } catch (err) {
    return serverError(res, err);
  }
}
