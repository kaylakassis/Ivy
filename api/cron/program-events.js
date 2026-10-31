// /api/cron/program-events - every 10 minutes:
//   1. live-session reminders, 24 hours and 1 hour before, to members who
//      RSVP'd going (or every member when the owner ticked "Remind
//      everyone"). Each (session, reminder, member) is sent once.
//   2. community emails that were held back: reply/mention emails batch to
//      one per thread per hour, and big fan-outs (announcements, recordings)
//      finish here when a request hit its per-request cap.
// Auth: Vercel cron bearer, or a signed-in super-admin poking it by hand.
import { cronAuthorized } from '../_lib/cronAuth.js';
import { sendDueReminders } from '../_lib/programEvents.js';
import { flushPendingEmails } from '../_lib/programCommunityNotify.js';
import { ok, serverError, unauthorized } from '../_lib/json.js';
import { trackCron } from '../_lib/cronMetrics.js';

async function handler(req, res) {
  if (!(await cronAuthorized(req))) return unauthorized(res);
  try {
    const reminders = await sendDueReminders();
    const emails = await flushPendingEmails();
    return ok(res, { reminders, emails });
  } catch (err) { return serverError(res, err); }
}

// Recorded in cron_runs so the hourly operator check can see it ran.
export default trackCron('program-events', handler);
