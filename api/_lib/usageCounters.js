// Per-workspace daily quota counters for email, SMS, and any other
// rate-limitable resource. A compromised or abusive workspace can
// burn shared Resend / Twilio reputation, hitting deliverability
// for every other workspace; this caps that blast radius.
//
// Storage: daily_usage_counters table (see schema.js). One row per
// (workspace_id, counter_key, day). The INSERT ... ON CONFLICT DO
// UPDATE pattern increments atomically - no race when two parallel
// requests from the same workspace hit at once.
//
// Caps are hard ceilings, not soft warnings. A workspace that hits
// 1000 emails/day stops sending until the next UTC day. An admin
// can adjust by writing a higher count manually (rare) or by
// raising the cap globally.
import { sql } from './db.js';

// Defaults. Override per-call when a specific endpoint needs a
// different limit (e.g. password-reset emails are critical and
// shouldn't be counted against the marketing-email quota).
export const DEFAULT_EMAIL_CAP_PER_DAY = 1000;
export const DEFAULT_SMS_CAP_PER_DAY   = 200;

// tryConsumeQuota - atomically increments the counter and returns
//   { ok: true,  count, cap }  → quota available, proceed
//   { ok: false, count, cap }  → cap reached, do NOT send
//
// workspaceId can be null/undefined for system-wide sends (e.g.
// the platform notifying us about a failed payment) - those skip
// the cap entirely. counterKey is short stable identifier
// ('email', 'sms', maybe 'email-marketing' later).
//
// Atomic on Postgres: the INSERT runs first and either inserts a
// fresh row at count=1 or conflicts and increments via the UPDATE
// path. The RETURNING count is the post-increment value, so the
// caller compares against `cap` to decide whether THIS send is
// over the line.
export async function tryConsumeQuota(workspaceId, counterKey, cap) {
  if (!workspaceId) return { ok: true, count: 0, cap };
  const today = new Date().toISOString().slice(0, 10);
  try {
    const { rows } = await sql`
      INSERT INTO daily_usage_counters (workspace_id, counter_key, day, count)
      VALUES (${workspaceId}, ${counterKey}, ${today}::date, 1)
      ON CONFLICT (workspace_id, counter_key, day)
      DO UPDATE SET count = daily_usage_counters.count + 1
      RETURNING count
    `;
    const count = rows[0]?.count ?? 1;
    return { ok: count <= cap, count, cap };
  } catch (err) {
    // Counter-table failure should never block real sends - log + allow.
    // (Worst case under partial-schema: cap is silently disabled until
    // the migrator catches up. Better than dropping every email.)
    // eslint-disable-next-line no-console
    console.error(`[usageCounters] ${counterKey} increment failed:`, err.message);
    return { ok: true, count: 0, cap };
  }
}

// Optional getter for admin dashboards. Returns today's count for
// a workspace + counter, or 0 if no row exists.
export async function getTodayCount(workspaceId, counterKey) {
  if (!workspaceId) return 0;
  const today = new Date().toISOString().slice(0, 10);
  try {
    const { rows } = await sql`
      SELECT count FROM daily_usage_counters
      WHERE workspace_id = ${workspaceId}
        AND counter_key = ${counterKey}
        AND day = ${today}::date
    `;
    return rows[0]?.count ?? 0;
  } catch {
    return 0;
  }
}
