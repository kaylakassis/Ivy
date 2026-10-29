// Hourly operator alerts. The operator should hear about a breakage by
// email first, not from Admin → Readiness or from a user. Four checks:
//
//   ivy_failures        failed assistant replies in the last 60 minutes
//                       (>= 5, or >= 20% of at least 10 attempts)
//   cron:<name>         a cron that vercel.json schedules has not succeeded
//                       within 2x its cadence (hourly: 3h, daily: 50h), or
//                       its last run failed
//   webhook_failures    >= 3 webhook deliveries we could not handle in the
//                       last hour (webhook_failures table)
//   webhook_signature   >= 5 signature / bearer rejections in the last hour
//   readiness:<key>     a required Readiness item (secrets, database, email
//                       provider) reports 'fail'
//
// Dedupe lives in ops_alert_state (api/_lib/opsAlerts.js): one email when
// a condition starts, a reminder at most every 6 hours while it lasts,
// one "Resolved" email when it clears. Recipient: OPS_ALERT_EMAIL, else
// SUPER_ADMIN_EMAIL. Documented in docs/ops-alerts.md.
import { sql } from '../_lib/db.js';
import { isSuperAdminBySession } from '../_lib/admin.js';
import { trackCron } from '../_lib/cronMetrics.js';
import { ok, serverError, unauthorized } from '../_lib/json.js';
import { SIGNATURE_FAILURE } from '../_lib/webhookFailures.js';
import {
  OPS_ALERT_CRON, loadCronSchedules, describeInterval, reconcileAlerts,
  sendOpsAlertEmail, opsAlertRecipient,
} from '../_lib/opsAlerts.js';
import { requiredChecks } from '../admin/prod-readiness.js';

export const IVY_FAILURE_MIN = 5;
export const IVY_FAILURE_RATE = 0.2;
export const IVY_FAILURE_MIN_ATTEMPTS = 10;
export const WEBHOOK_FAILURE_MIN = 3;
export const WEBHOOK_SIGNATURE_MIN = 5;

const READINESS_PAGE = 'Admin → Readiness';

// ── Checks. Each returns [] or a list of { key, severity, title, detail, where }.

export async function checkIvyFailures() {
  const f = await sql`
    SELECT COUNT(*)::int AS n FROM ivy_failures WHERE created_at > NOW() - INTERVAL '60 minutes'`;
  const failures = f.rows[0]?.n || 0;
  if (failures === 0) return [];
  // ivy_usage only records successful replies, by day. Rows touched in the
  // last hour approximate the hour's successes (a busy workspace's whole
  // day counts, which only makes the rate more conservative).
  const u = await sql`
    SELECT COALESCE(SUM(request_count), 0)::int AS n FROM ivy_usage WHERE updated_at > NOW() - INTERVAL '60 minutes'`;
  const successes = u.rows[0]?.n || 0;
  const attempts = failures + successes;
  const rate = attempts ? failures / attempts : 1;
  const fires = failures >= IVY_FAILURE_MIN
    || (attempts >= IVY_FAILURE_MIN_ATTEMPTS && rate >= IVY_FAILURE_RATE);
  if (!fires) return [];
  const top = await sql`
    SELECT COALESCE(NULLIF(message, ''), '(no message)') AS message, COUNT(*)::int AS n
      FROM ivy_failures WHERE created_at > NOW() - INTERVAL '60 minutes'
     GROUP BY 1 ORDER BY n DESC LIMIT 1`;
  const common = top.rows[0];
  const pct = Math.round(rate * 100);
  return [{
    key: 'ivy_failures',
    severity: rate >= 0.5 || failures >= 20 ? 'critical' : 'warning',
    title: `Ivy failures: ${failures} in the last hour`,
    detail: `${failures} failed repl${failures === 1 ? 'y' : 'ies'} out of about ${attempts} attempt${attempts === 1 ? '' : 's'} (${pct}%). `
      + `Most common error: "${String(common?.message || '').slice(0, 160)}" (${common?.n || 0} time${common?.n === 1 ? '' : 's'}).`,
    where: `${READINESS_PAGE} (Ivy failed replies and the Ivy assistant probe)`,
  }];
}

export async function checkCronHealth({ now = new Date() } = {}) {
  const schedules = loadCronSchedules().filter((c) => c.name !== OPS_ALERT_CRON);
  const { rows: stats } = await sql`
    SELECT name,
           MAX(finished_at) FILTER (WHERE ok = TRUE) AS last_ok_at,
           MAX(finished_at)                          AS last_run_at
      FROM cron_runs
     WHERE finished_at IS NOT NULL
     GROUP BY name`;
  const { rows: last } = await sql`
    SELECT DISTINCT ON (name) name, ok, error_message, finished_at
      FROM cron_runs WHERE finished_at IS NOT NULL
     ORDER BY name, finished_at DESC`;
  // Record when each job was first seen with its current schedule. A new
  // job, or one whose schedule changed, starts its clock from that moment.
  const seenByName = new Map();
  for (const c of schedules) {
    const r = await sql`
      INSERT INTO cron_schedule_seen (name, schedule, first_seen_at)
      VALUES (${c.name}, ${c.schedule}, ${now.toISOString()})
      ON CONFLICT (name) DO UPDATE SET
        schedule = EXCLUDED.schedule,
        first_seen_at = CASE WHEN cron_schedule_seen.schedule IS DISTINCT FROM EXCLUDED.schedule
                             THEN EXCLUDED.first_seen_at ELSE cron_schedule_seen.first_seen_at END
      RETURNING first_seen_at`;
    seenByName.set(c.name, new Date(r.rows[0].first_seen_at).getTime());
  }
  const byName = new Map(stats.map((s) => [s.name, s]));
  const lastByName = new Map(last.map((l) => [l.name, l]));
  const nowMs = now.getTime();
  const out = [];
  for (const c of schedules) {
    const s = byName.get(c.name);
    const l = lastByName.get(c.name);
    const lastOkMs = s?.last_ok_at ? new Date(s.last_ok_at).getTime() : null;
    const seenMs = seenByName.get(c.name) ?? nowMs;
    const cadence = describeInterval(c.schedule);
    const windowH = Math.round(c.staleAfterMs / 3600e3);
    if (lastOkMs == null) {
      // Never succeeded. Only meaningful once this job has existed with
      // this schedule for longer than its window.
      if (nowMs - seenMs > c.staleAfterMs) {
        out.push({
          key: `cron:${c.name}`, severity: 'critical',
          title: `Cron overdue: ${c.name}`,
          detail: `Scheduled ${cadence} (${c.schedule}) but it has never recorded a successful run${l ? `; the last run at ${fmt(l.finished_at)} failed: ${String(l.error_message || 'no error message').slice(0, 200)}` : ''}. Expected a success within ${windowH} hours.`,
          where: `${READINESS_PAGE} (CRON_SECRET), then the cron health report at /api/admin/cron-health and the Vercel cron logs`,
        });
      }
      continue;
    }
    // Judge from the later of the last success and when the current
    // schedule took effect (a daily job just moved to hourly gets a full
    // hourly window before it counts as late).
    if (nowMs - Math.max(lastOkMs, seenMs) > c.staleAfterMs) {
      out.push({
        key: `cron:${c.name}`, severity: 'critical',
        title: `Cron overdue: ${c.name}`,
        detail: `Scheduled ${cadence} (${c.schedule}); last success ${fmt(s.last_ok_at)}, more than ${windowH} hours ago.${l && l.ok === false ? ` Last run at ${fmt(l.finished_at)} failed: ${String(l.error_message || 'no error message').slice(0, 200)}.` : ''}`,
        where: `${READINESS_PAGE} (CRON_SECRET), then the cron health report at /api/admin/cron-health and the Vercel cron logs`,
      });
    } else if (l && l.ok === false) {
      out.push({
        key: `cron:${c.name}`, severity: 'warning',
        title: `Cron failed: ${c.name}`,
        detail: `Last run at ${fmt(l.finished_at)} failed: ${String(l.error_message || 'no error message').slice(0, 200)}. Last success ${fmt(s.last_ok_at)}.`,
        where: 'The cron health report at /api/admin/cron-health and the Vercel function logs for this cron',
      });
    }
  }
  return out;
}

export async function checkWebhookFailures() {
  const { rows } = await sql`
    SELECT source, event_type, COALESCE(NULLIF(message, ''), '(no message)') AS message
      FROM webhook_failures WHERE created_at > NOW() - INTERVAL '60 minutes'`;
  if (rows.length === 0) return [];
  const sig = rows.filter((r) => r.event_type === SIGNATURE_FAILURE);
  const other = rows.filter((r) => r.event_type !== SIGNATURE_FAILURE);
  const out = [];
  if (sig.length >= WEBHOOK_SIGNATURE_MIN) {
    out.push({
      key: 'webhook_signature', severity: 'critical',
      title: `Webhook signature failures: ${sig.length} in the last hour`,
      detail: `Rejected deliveries by source: ${countBy(sig, 'source')}. Usually a rotated or misrouted signing secret; while it lasts, those providers' events are not being applied.`,
      where: `${READINESS_PAGE} (webhook secrets), then the provider's webhook dashboard for the failing source`,
    });
  }
  // Signature rejections that did not reach a burst still count toward
  // the general failure total.
  const general = sig.length >= WEBHOOK_SIGNATURE_MIN ? other : rows;
  if (general.length >= WEBHOOK_FAILURE_MIN) {
    const top = mostCommon(general.map((r) => r.message));
    out.push({
      key: 'webhook_failures', severity: 'warning',
      title: `Webhook failures: ${general.length} in the last hour`,
      detail: `By source: ${countBy(general, 'source')}. Most common error: "${top.value.slice(0, 160)}" (${top.n} time${top.n === 1 ? '' : 's'}). Providers retry on their own; the fix is in the handler or its configuration.`,
      where: `${READINESS_PAGE}, then the Vercel function logs for /api/webhooks/* and the provider's webhook dashboard`,
    });
  }
  return out;
}

export async function checkReadiness() {
  const checks = await requiredChecks();
  return checks
    .filter((c) => c.level === 'fail')
    .map((c) => ({
      key: `readiness:${c.key}`, severity: 'critical',
      title: `Readiness: ${c.label} is failing`,
      detail: String(c.detail || 'Reported as a blocker.').slice(0, 300),
      where: READINESS_PAGE,
    }));
}

// Run every check, never letting one broken check hide the others. A check
// that throws becomes its own warning so the breakage is still reported.
export async function runOpsChecks({ now = new Date() } = {}) {
  const groups = [
    ['ivy_failures', () => checkIvyFailures()],
    ['cron_health', () => checkCronHealth({ now })],
    ['webhook_failures', () => checkWebhookFailures()],
    ['readiness', () => checkReadiness()],
  ];
  const firing = [];
  for (const [name, fn] of groups) {
    try {
      firing.push(...await fn());
    } catch (err) {
      firing.push({
        key: `check_error:${name}`, severity: 'warning',
        title: `Alert check could not run: ${name}`,
        detail: String(err?.message || err).slice(0, 300),
        where: 'The Vercel function logs for /api/cron/ops-alerts',
      });
    }
  }
  const order = { critical: 0, warning: 1 };
  firing.sort((a, b) => (order[a.severity] ?? 2) - (order[b.severity] ?? 2) || a.key.localeCompare(b.key));
  return firing;
}

async function handler(req, res) {
  const cronAuth = !!process.env.CRON_SECRET
    && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
  const adminAuth = process.env.ADMIN_SECRET
    && req.headers['x-admin-secret'] === process.env.ADMIN_SECRET;
  const userAuth = !cronAuth && !adminAuth ? await isSuperAdminBySession(req) : false;
  if (!cronAuth && !adminAuth && !userAuth) return unauthorized(res);
  try {
    const now = new Date();
    const firing = await runOpsChecks({ now });
    const r = await reconcileAlerts({ firing, now, send: sendOpsAlertEmail });
    return ok(res, {
      recipient: !!opsAlertRecipient(),
      firing: firing.length,
      started: r.started.length,
      reminded: r.reminded.length,
      resolved: r.resolved.length,
      emailed: r.emailed,
      alerts: r.active.map((a) => ({ key: a.key, severity: a.severity, title: a.title })),
      resolvedKeys: r.resolved.map((a) => a.key),
    });
  } catch (err) {
    return serverError(res, err);
  }
}

export default trackCron(OPS_ALERT_CRON, handler);

function fmt(d) {
  const x = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(x.getTime())) return String(d);
  return `${x.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
function countBy(rows, field) {
  const m = new Map();
  for (const r of rows) m.set(r[field] || 'unknown', (m.get(r[field] || 'unknown') || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ');
}
function mostCommon(values) {
  const m = new Map();
  for (const v of values) m.set(v, (m.get(v) || 0) + 1);
  let best = { value: '', n: 0 };
  for (const [value, n] of m) if (n > best.n) best = { value, n };
  return best;
}
