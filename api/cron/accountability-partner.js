// /api/cron/accountability-partner - Ivy, the owner's accountability partner.
//
// Hourly. For each eligible owner whose LOCAL time is between 9am and 7pm,
// at most one message per owner-local day:
//   • Away check-ins: no visit for 3+ days → a warm catch-up; still away at
//     7+ days → a gentler last one; then nothing until they come back (a
//     newer users.last_active_at than partner_away_sent_at resets it).
//     While away 3+ days, no daily digests either.
//   • Otherwise a daily digest of what needs attention (api/_lib/
//     accountability.js), sent only when something is NEW or has been open
//     past its repeat window, so the same list is not repeated every day.
//     Frequency 'important' keeps only the most important items; 'weekly'
//     writes at most once a week.
//
// Channels: push + the in-app bell (notifyOwner, gated by the owner's
// 'accountability' switch). Email (type 'accountability', preference-gated
// with one-click unsubscribe) goes out for the away check-ins, for the
// weekly digest, and for a daily digest that no device received, so an
// owner with notifications on is not told the same thing twice.
//
// Eligible: the business owner only (never helpers, never clients), not
// deleted, not a tester / beta / sponsored / super-admin account, onboarded,
// with an active plan or trial (owners with no plan get the sign-up
// reminders instead), partner switched on, not snoozed today.
//
// This cron replaces three older nudges so an owner never gets the same
// nudge twice: the per-client ivy-nudges pushes (waiting on your reply,
// gone quiet), the daily-return morning briefing push, and (for owners
// with the partner on) the day-10 owner-reengage email. It also stays
// silent on a day the setup nudge or a sign-up reminder already went out.
import { sql } from '../_lib/db.js';
import { cronAuthorized } from '../_lib/cronAuth.js';
import { trackCron } from '../_lib/cronMetrics.js';
import { notifyOwner } from '../_lib/push.js';
import { sendEmailToUser } from '../_lib/email.js';
import { appUrl } from '../_lib/tokens.js';
import { reportError } from '../_lib/monitoring.js';
import { ok, serverError, unauthorized } from '../_lib/json.js';
import { shardFromReq, shardClause, withDeadline, terminationReason } from '../_lib/cronShard.js';
import {
  computeSignals, messageableItems, isFresh, composeMessage, renderPartnerEmail,
  resolvePartnerSettings, firstNameOf,
  SEND_FROM_HOUR, SEND_UNTIL_HOUR, AWAY_FIRST_DAYS, AWAY_SECOND_DAYS,
} from '../_lib/accountability.js';

const BATCH_SIZE = 200;
// A business is looked at about every 3 hours inside its 9am-7pm window
// (9, 12, 3 and 6 o'clock or so), not every hour.
const RECHECK_MINUTES = 170;
const WEEKLY_HOURS = 6.5 * 24;

// Active plan or live trial, same rule as the weekly recap
// (isWorkspaceActive): trial still running, paid period running, past_due
// in its retry window, or a complimentary grant.
const ACTIVE_PLAN = `(
  (w.subscription_status = 'trialing' AND w.trial_ends_at > NOW())
  OR (w.subscription_status = 'active' AND (w.subscription_period_end IS NULL OR w.subscription_period_end > NOW()))
  OR (w.subscription_status = 'past_due')
  OR (w.comp_until > NOW())
)`;

// cs.timezone is guarded through pg_timezone_names so an unknown name can't
// throw the query (falls back to UTC). Never inline it into AT TIME ZONE.
const LOCAL = `(NOW() AT TIME ZONE COALESCE(z.name, 'UTC'))`;

export function candidateQuery(shardFilter = '') {
  return `
    SELECT w.id AS workspace_id, w.owner_id, COALESCE(z.name, 'UTC') AS tz,
           ${LOCAL}::date::text AS local_day,
           u.name, u.email, u.last_active_at, u.notification_prefs, u.accountability_prefs,
           w.partner_last_sent_at, w.partner_mentioned, w.partner_away_step, w.partner_away_sent_at,
           w.setup_nudge_sent_at, u.signup_reminder_last_sent_at
      FROM workspaces w
      JOIN users u ON u.id = w.owner_id AND u.deleted_at IS NULL
      LEFT JOIN calendar_settings cs ON cs.workspace_id = w.id
      LEFT JOIN pg_timezone_names  z ON z.name = cs.timezone
     WHERE w.onboarded_at IS NOT NULL
       AND w.data_purged_at IS NULL
       AND COALESCE(u.user_type, 'regular') NOT IN ('beta', 'sponsored', 'super_admin')
       AND NOT COALESCE(u.is_tester, FALSE)
       AND ${ACTIVE_PLAN}
       AND COALESCE(u.notification_prefs->>'accountability', 'true') <> 'false'
       AND EXTRACT(HOUR FROM ${LOCAL})::int >= ${SEND_FROM_HOUR}
       AND EXTRACT(HOUR FROM ${LOCAL})::int <  ${SEND_UNTIL_HOUR}
       AND (w.partner_last_sent_day IS NULL OR w.partner_last_sent_day < ${LOCAL}::date)
       AND (w.partner_snoozed_day IS NULL OR w.partner_snoozed_day <> ${LOCAL}::date)
       AND (w.partner_checked_at IS NULL OR w.partner_checked_at < NOW() - INTERVAL '${RECHECK_MINUTES} minutes')
       ${shardFilter}
     ORDER BY w.partner_checked_at ASC NULLS FIRST, w.id
     LIMIT ${BATCH_SIZE}`;
}

// Decide what (if anything) to send to one owner. Pure apart from the
// signals read, so tests can drive it. Returns null or
// { kind: 'digest'|'away1'|'away2', items, mentionedNext? }.
export async function planForWorkspace(r, { now = Date.now() } = {}) {
  const settings = resolvePartnerSettings(r.notification_prefs, r.accountability_prefs);
  if (!settings.enabled) return null;

  // Ivy already wrote today (the one-shot setup email or a sign-up reminder).
  const DAY = 20 * 3600000;
  if (r.setup_nudge_sent_at && now - new Date(r.setup_nudge_sent_at).getTime() < DAY) return null;
  if (r.signup_reminder_last_sent_at && now - new Date(r.signup_reminder_last_sent_at).getTime() < DAY) return null;

  const lastActive = r.last_active_at ? new Date(r.last_active_at).getTime() : null;
  const awayDays = lastActive ? (now - lastActive) / 86400000 : 0;

  if (lastActive && awayDays >= AWAY_FIRST_DAYS) {
    // Away. The step only counts if it was sent during THIS absence.
    const step = r.partner_away_sent_at && new Date(r.partner_away_sent_at).getTime() > lastActive
      ? Number(r.partner_away_step || 0) : 0;
    if (!settings.kinds.checkins) return null;
    let kind = null;
    if (awayDays >= AWAY_SECOND_DAYS && step < 2) kind = 'away2';
    else if (step < 1) kind = 'away1';
    if (!kind) return null; // both check-ins sent: stop until they come back
    const items = messageableItems(await computeSignals(r.workspace_id, { tz: r.tz }), settings);
    return { kind, items, awayStep: kind === 'away2' ? 2 : 1 };
  }

  if (settings.frequency === 'weekly' && r.partner_last_sent_at
      && now - new Date(r.partner_last_sent_at).getTime() < WEEKLY_HOURS * 3600000) return null;

  const items = messageableItems(await computeSignals(r.workspace_id, { tz: r.tz }), settings);
  if (!items.length) return null;
  const mentioned = r.partner_mentioned && typeof r.partner_mentioned === 'object' ? r.partner_mentioned : {};
  if (!items.some((it) => isFresh(it, mentioned, now))) return null;
  return { kind: 'digest', items, weekly: settings.frequency === 'weekly' };
}

// Email goes out for the away check-ins, a weekly digest, and a daily
// digest that reached no device (so it is never said twice).
export function shouldEmail({ kind, weekly = false, emailEnabled, hasEmail, reachedDevice }) {
  if (!emailEnabled || !hasEmail) return false;
  return kind !== 'digest' || weekly || !reachedDevice;
}

async function deliver(r, plan) {
  const settings = resolvePartnerSettings(r.notification_prefs, r.accountability_prefs);
  const msg = composeMessage({ kind: plan.kind, items: plan.items });
  const tag = plan.kind === 'digest' ? 'accountability-partner' : 'accountability-away';
  // Push + bell. notifyOwner records the bell row first, then pushes to
  // every device; the 'accountability' switch gates both.
  const pushed = await notifyOwner({
    workspaceId: r.workspace_id, type: 'accountability',
    payload: { title: msg.title, body: msg.body, url: msg.url, tag },
  }).catch(() => ({ sent: 0 }));
  const reachedDevice = Number(pushed?.sent || 0) > 0;
  let emailed = false;
  if (shouldEmail({ kind: plan.kind, weekly: plan.weekly, emailEnabled: settings.emailEnabled, hasEmail: !!r.email, reachedDevice })) {
    const mail = renderPartnerEmail({ kind: plan.kind, items: plan.items, firstName: firstNameOf(r.name), baseUrl: appUrl() });
    const out = await sendEmailToUser({
      userId: r.owner_id, type: 'accountability', to: r.email,
      subject: mail.subject, html: mail.html, text: mail.text,
    }).catch(() => null);
    emailed = !!out?.sent;
  }
  return { pushed: reachedDevice, emailed };
}

async function handler(req, res) {
  if (!(await cronAuthorized(req))) return unauthorized(res);
  try {
    const { shard, shards } = shardFromReq(req);
    const shardFilter = shardClause({ shard, shards }, 'w.id');
    const counts = { scanned: 0, sent: 0, digests: 0, checkins: 0, quiet: 0, emailed: 0 };
    let emptied = false;

    await withDeadline(async (deadline) => {
      while (Date.now() < deadline) {
        const { rows } = await sql.query(candidateQuery(shardFilter));
        if (rows.length === 0) { emptied = true; break; }
        for (const r of rows) {
          counts.scanned++;
          try {
            // Claim the look first (drops it from the next batch, and a
            // concurrent run that lost the race skips it).
            const claim = await sql`
              UPDATE workspaces SET partner_checked_at = NOW()
               WHERE id = ${r.workspace_id}
                 AND (partner_checked_at IS NULL OR partner_checked_at < NOW() - (${String(RECHECK_MINUTES)} || ' minutes')::interval)
              RETURNING id`;
            if (!claim.rows.length) continue;
            const plan = await planForWorkspace(r);
            if (!plan) { counts.quiet++; continue; }

            // Claim the DAY before sending: one message per owner-local day,
            // even under a retried or overlapping run.
            const mentioned = { ...(r.partner_mentioned || {}) };
            const at = new Date().toISOString();
            for (const it of plan.items) mentioned[it.key] = { at, fp: it.fingerprint };
            const day = await sql`
              UPDATE workspaces
                 SET partner_last_sent_at = NOW(),
                     partner_last_sent_day = ${r.local_day}::date,
                     partner_mentioned = ${JSON.stringify(mentioned)}::jsonb,
                     partner_away_step = CASE WHEN ${plan.awayStep || 0}::int > 0 THEN ${plan.awayStep || 0}::int ELSE partner_away_step END,
                     partner_away_sent_at = CASE WHEN ${plan.awayStep || 0}::int > 0 THEN NOW() ELSE partner_away_sent_at END
               WHERE id = ${r.workspace_id}
                 AND (partner_last_sent_day IS NULL OR partner_last_sent_day < ${r.local_day}::date)
              RETURNING id`;
            if (!day.rows.length) continue;
            const out = await deliver(r, plan);
            counts.sent++;
            if (plan.kind === 'digest') counts.digests++; else counts.checkins++;
            if (out.emailed) counts.emailed++;
          } catch (err) {
            console.warn('[accountability-partner] failed for', r.workspace_id, err.message);
            reportError(err, { extra: { workspaceId: r.workspace_id } });
          }
          if (Date.now() >= deadline) break;
        }
      }
    });

    const terminatedBy = terminationReason({ emptied, hitCap: false });
    return ok(res, { shard, shards, ...counts, terminatedBy });
  } catch (err) {
    return serverError(res, err);
  }
}

export default trackCron('accountability-partner', handler);
