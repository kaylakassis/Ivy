// Hourly "finish signing up" reminders (api/_lib/signupReminders.js has
// the rules and the copy). An owner who created an account but never
// started a trial or a plan gets up to three emails: about 3 hours, about
// 24 hours and about 3 days after sign-up, then nothing more.
//
// Each send is claimed one by one (a guarded bump of
// users.signup_reminder_step), so a retried or overlapping run never sends
// a step twice, and a run stopped by the time budget leaves nothing half
// done: the next hourly run carries on. Bounded per run.
//
// Auth: same three paths as the other crons (cronAuthorized). Registered
// in vercel.json.
import { cronAuthorized } from '../_lib/cronAuth.js';
import { trackCron } from '../_lib/cronMetrics.js';
import { makeDeadline } from '../_lib/timeBudget.js';
import { shardFromReq, shardClause, terminationReason } from '../_lib/cronShard.js';
import { findDueReminders, sendNextReminder } from '../_lib/signupReminders.js';
import { ok, serverError, unauthorized } from '../_lib/json.js';

const BATCH_SIZE = 100;
// Paranoia rail: far above normal hourly volume.
const MAX_PER_RUN = 1000;

async function handler(req, res) {
  if (!(await cronAuthorized(req))) return unauthorized(res);
  try {
    const { shard, shards } = shardFromReq(req);
    const shardFilter = shardClause({ shard, shards }, 'u.id');
    const deadline = makeDeadline();

    const counts = { scanned: 0, sent: 0, muted: 0, skipped: 0, failed: 0 };
    let emptied = false;
    // Every candidate is either claimed (and drops out for 23 hours) or
    // skipped because it stopped qualifying (and drops out too), except a
    // send the provider refused, which is released for the next run. Stop
    // a batch early if it made no progress so a provider outage cannot spin.
    while (!deadline.passed() && counts.scanned < MAX_PER_RUN) {
      // eslint-disable-next-line no-await-in-loop
      const rows = await findDueReminders({ limit: BATCH_SIZE, shardFilter });
      if (rows.length === 0) { emptied = true; break; }
      counts.scanned += rows.length;
      let progressed = 0;
      for (const row of rows) {
        if (deadline.passed()) break;
        // eslint-disable-next-line no-await-in-loop
        const outcome = await sendNextReminder(row);
        counts[outcome] = (counts[outcome] || 0) + 1;
        if (outcome !== 'failed') progressed++;
      }
      if (progressed === 0) break;
    }

    const terminatedBy = terminationReason({ emptied, hitCap: counts.scanned >= MAX_PER_RUN });
    return ok(res, { shard, shards, ...counts, terminatedBy });
  } catch (err) {
    return serverError(res, err);
  }
}

export default trackCron('signup-reminders', handler);
