// Numbers for the admin "Accountability partner" tab (GET
// /api/admin/accountability-partner). Counts and dates only: no names, no
// emails, no ids, no message text.
//
// Where each number comes from:
//   reach      the owners the partner can write to (same rules as the cron:
//              onboarded, on a plan or trial, not deleted, not a test /
//              beta / sponsored / super-admin account) and their switches
//              (users.notification_prefs, users.accountability_prefs).
//   snoozes    partner_events 'snoozed' ("Not today").
//   sends      partner_events 'sent', one per message, with its kind, how
//              many devices the push reached and whether the email went.
//   opens      opened_at: the owner used the app within 24 hours after the
//              message (any visit, not necessarily because of it).
//              clicked_at: they opened it from the message's own link.
//   cleared    partner_mentions: of the items a message named, how many were
//              no longer waiting within 48 hours (re-checked about every two
//              hours by the cron, so this can only read low, never high).
//   turn-offs  partner_events 'turned_off' by route, with days since the
//              owner signed up; 'warning_kept' = saw the warning, kept it on.
//
// Rates are only shown once there are MIN_SAMPLE cases behind them; before
// that the tab says "Collecting data since <date>". `workspaceIds` scopes
// every query (tests seed their own businesses).
import { sql } from './db.js';
import { ACTIVE_PLAN } from '../cron/accountability-partner.js';
import { PARTNER_FREQUENCIES, MENTION_WINDOW_HOURS } from './accountability.js';

export const MIN_SAMPLE = 10;
export const SEND_KINDS = ['daily', 'weekly', 'away3', 'away7'];
export const SEND_KIND_LABELS = {
  daily: 'Daily digest', weekly: 'Weekly digest', away3: '3-day away check-in', away7: '7-day away check-in',
};
// What "cleared" means for each item the partner can name.
export const SIGNAL_LABELS = {
  unread_messages: ['Unanswered client messages', 'The named conversations no longer have unread client messages waiting (opened or answered)'],
  leads_waiting: ['New leads waiting for a reply', 'Each named lead got a first message from the business'],
  deposit_reviews: ['Deposit refund requests', 'The named requests were decided (refunded or kept)'],
  autopay_failed: ['Automatic payments that failed', 'The named invoices were paid, voided or archived'],
  invoices_overdue: ['Overdue invoices', 'None of the named invoices is still overdue (paid, voided or archived)'],
  deposits_unpaid_today: ["Today's unpaid deposits", 'The named deposits were paid or the bookings changed'],
  docs_unsent: ['Documents drafted but not sent', 'The named documents were sent (or deleted)'],
  docs_unsigned: ['Documents waiting for a signature', 'The named documents were signed, declined or withdrawn'],
  invoices_draft: ['Draft invoices not sent', 'The named invoices were sent (or deleted)'],
  tasks_due: ['Tasks due', 'The named tasks were done or moved'],
  setup: ['Unfinished setup', 'That setup step was finished'],
  quiet_clients: ['Quiet clients', 'The named clients booked or exchanged a message'],
  packages_low: ['Clients almost out of package sessions', 'The named clients rebooked or got a new package'],
  reviews_reply: ['Reviews to reply to', 'The named reviews got a reply'],
  duplicates: ['Possible duplicate clients', 'The duplicates were merged or dismissed'],
  quiet_week: ['A quiet week ahead', 'The next 7 days filled up enough that the note no longer applies'],
  missing_email: ['Clients booked this week with no email', 'The named clients got an email address'],
};
const SIGNUP_BUCKETS = [
  ['day0', 'Same day as sign-up', 0, 1],
  ['week1', '1 to 6 days after', 1, 7],
  ['month1', '1 to 4 weeks after', 7, 30],
  ['months3', '1 to 3 months after', 30, 90],
  ['later', 'More than 3 months after', 90, null],
];
const SOURCE_LABELS = {
  settings: 'In Settings, after the warning',
  ivy: "Through Ivy (the approval card shows the same warning)",
  other: 'Another way, without the warning (for example an older app version)',
};

const pct = (n, d) => (d >= MIN_SAMPLE ? Math.round((n / d) * 1000) / 10 : null);
const num = (v) => Number(v || 0);

export async function partnerStats({ workspaceIds = null } = {}) {
  const scoped = Array.isArray(workspaceIds);
  const ids = scoped ? workspaceIds.map(String) : [];
  // $1 is always the id list; the filter is a no-op when unscoped.
  const W = (col) => `(NOT $2::boolean OR ${col} = ANY($1::uuid[]))`;
  const q = (text) => sql.query(text, [ids, scoped]);

  const [reach, snoozes, since, sendsDaily, sendTotals, opens, mentions, turnOffs, kept] = await Promise.all([
    q(`SELECT COUNT(*)::int AS eligible,
              COUNT(*) FILTER (WHERE COALESCE(u.notification_prefs->>'accountability', 'true') <> 'false')::int AS on_count,
              COUNT(*) FILTER (WHERE COALESCE(u.notification_prefs->>'accountability', 'true') <> 'false'
                               AND COALESCE(u.notification_prefs->>'email_accountability', 'true') <> 'false')::int AS email_on,
              ${PARTNER_FREQUENCIES.map((f) => `COUNT(*) FILTER (WHERE COALESCE(u.notification_prefs->>'accountability', 'true') <> 'false'
                 AND (CASE WHEN u.accountability_prefs->>'frequency' IN (${PARTNER_FREQUENCIES.map((x) => `'${x}'`).join(',')})
                           THEN u.accountability_prefs->>'frequency' ELSE 'daily' END) = '${f}')::int AS freq_${f}`).join(',\n')}
         FROM workspaces w
         JOIN users u ON u.id = w.owner_id AND u.deleted_at IS NULL
        WHERE w.onboarded_at IS NOT NULL AND w.data_purged_at IS NULL
          AND COALESCE(u.user_type, 'regular') NOT IN ('beta', 'sponsored', 'super_admin')
          AND NOT COALESCE(u.is_tester, FALSE)
          AND ${ACTIVE_PLAN}
          AND ${W('w.id')}`),
    q(`SELECT COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::int AS n7,
              COUNT(DISTINCT workspace_id) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::int AS owners7,
              COUNT(*)::int AS n30, COUNT(DISTINCT workspace_id)::int AS owners30
         FROM partner_events
        WHERE event = 'snoozed' AND created_at >= NOW() - INTERVAL '30 days' AND ${W('workspace_id')}`),
    // Tracking start: the first event recorded live (backfilled turn-offs
    // carry a ref and do not count).
    q(`SELECT MIN(created_at) AS at FROM partner_events WHERE ref IS NULL AND ${W('workspace_id')}`),
    q(`SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, kind, COUNT(*)::int AS n
         FROM partner_events
        WHERE event = 'sent' AND created_at >= (NOW() AT TIME ZONE 'UTC')::date - 29 AND ${W('workspace_id')}
        GROUP BY 1, 2`),
    q(`SELECT COUNT(*)::int AS sent,
              COUNT(*) FILTER (WHERE push_devices > 0)::int AS pushed,
              COUNT(*) FILTER (WHERE emailed)::int AS emailed,
              COUNT(*) FILTER (WHERE push_devices > 0 AND emailed)::int AS both,
              COUNT(*) FILTER (WHERE COALESCE(push_devices, 0) = 0 AND NOT COALESCE(emailed, FALSE))::int AS bell_only
         FROM partner_events
        WHERE event = 'sent' AND created_at >= NOW() - INTERVAL '30 days' AND ${W('workspace_id')}`),
    // Only messages whose 24 hours are over count, so the rate is final.
    q(`SELECT kind,
              COUNT(*)::int AS n,
              COUNT(*) FILTER (WHERE opened_at IS NOT NULL)::int AS opened,
              COUNT(*) FILTER (WHERE clicked_at IS NOT NULL AND clicked_at <= created_at + INTERVAL '24 hours')::int AS clicked,
              COUNT(*) FILTER (WHERE clicked_at IS NOT NULL AND clicked_at <= created_at + INTERVAL '24 hours' AND click_channel = 'email')::int AS clicked_email
         FROM partner_events
        WHERE event = 'sent' AND created_at >= NOW() - INTERVAL '30 days' AND created_at <= NOW() - INTERVAL '24 hours'
          AND ${W('workspace_id')}
        GROUP BY kind`),
    q(`SELECT signal_key,
              COUNT(*) FILTER (WHERE settled)::int AS settled,
              COUNT(*) FILTER (WHERE settled AND cleared_at IS NOT NULL
                               AND cleared_at <= mentioned_at + INTERVAL '${MENTION_WINDOW_HOURS} hours')::int AS cleared,
              COUNT(*) FILTER (WHERE NOT settled)::int AS pending
         FROM partner_mentions
        WHERE mentioned_at >= NOW() - INTERVAL '30 days' AND ${W('workspace_id')}
        GROUP BY signal_key`),
    q(`SELECT pe.source,
              FLOOR(EXTRACT(EPOCH FROM (pe.created_at - u.created_at)) / 86400)::int AS days,
              (pe.ref IS NULL) AS live
         FROM partner_events pe
         JOIN users u ON u.id = pe.user_id
        WHERE pe.event = 'turned_off' AND ${W('pe.workspace_id')}`),
    q(`SELECT COUNT(*)::int AS n
         FROM partner_events WHERE event = 'warning_kept' AND ${W('workspace_id')}`),
  ]);

  const r = reach.rows[0] || {};
  const eligible = num(r.eligible);
  const on = num(r.on_count);
  const trackingSince = since.rows[0]?.at ? new Date(since.rows[0].at).toISOString() : null;

  // Sends per day: the last 30 UTC days, oldest first. Days before tracking
  // began are null (not collected), never zero.
  const byDay = new Map();
  for (const row of sendsDaily.rows) {
    const d = byDay.get(row.day) || {};
    if (SEND_KINDS.includes(row.kind)) d[row.kind] = num(row.n);
    byDay.set(row.day, d);
  }
  const startDay = trackingSince ? trackingSince.slice(0, 10) : null;
  const days = [];
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  for (let i = 29; i >= 0; i--) {
    const day = new Date(today.getTime() - i * 86400000).toISOString().slice(0, 10);
    const collected = !!startDay && day >= startDay;
    const d = byDay.get(day) || {};
    days.push({
      day, collected,
      ...Object.fromEntries(SEND_KINDS.map((k) => [k, collected ? (d[k] || 0) : null])),
    });
  }

  const t = sendTotals.rows[0] || {};
  const openRows = opens.rows;
  const openTotal = openRows.reduce((a, x) => ({ n: a.n + num(x.n), opened: a.opened + num(x.opened), clicked: a.clicked + num(x.clicked), clickedEmail: a.clickedEmail + num(x.clicked_email) }), { n: 0, opened: 0, clicked: 0, clickedEmail: 0 });

  const signals = mentions.rows.map((m) => ({
    key: m.signal_key,
    label: SIGNAL_LABELS[m.signal_key]?.[0] || 'Other',
    meaning: SIGNAL_LABELS[m.signal_key]?.[1] || '',
    mentioned: num(m.settled), cleared: num(m.cleared), stillOpen: num(m.pending),
    clearedPct: pct(num(m.cleared), num(m.settled)),
  })).sort((a, b) => (b.mentioned + b.stillOpen) - (a.mentioned + a.stillOpen));

  const bucketOf = (days) => (SIGNUP_BUCKETS.find(([, , lo, hi]) => days >= lo && (hi == null || days < hi)) || SIGNUP_BUCKETS.at(-1))[0];
  const offs = turnOffs.rows.map((x) => ({ source: ['settings', 'ivy'].includes(x.source) ? x.source : 'other', days: Math.max(0, num(x.days)), live: !!x.live }));
  const bySource = Object.keys(SOURCE_LABELS).map((source) => {
    const list = offs.filter((o) => o.source === source);
    return {
      source, label: SOURCE_LABELS[source], count: list.length,
      whenAfterSignup: SIGNUP_BUCKETS.map(([id, label]) => ({ id, label, count: list.filter((o) => bucketOf(o.days) === id).length })),
    };
  });
  const sorted = offs.map((o) => o.days).sort((a, b) => a - b);
  const median = sorted.length ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : Math.round((sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2)) : null;
  // The warning's own score: only over the time "Keep it on" was counted
  // (since tracking began), so both sides cover the same days.
  const keptN = num(kept.rows[0]?.n);
  const offAfterWarningLive = offs.filter((o) => o.live && o.source === 'settings').length;

  return {
    generatedAt: new Date().toISOString(),
    trackingSince,
    minSample: MIN_SAMPLE,
    reach: {
      eligible,
      on, off: eligible - on,
      offPct: eligible ? Math.round(((eligible - on) / eligible) * 1000) / 10 : null,
      emailOn: num(r.email_on), emailOff: on - num(r.email_on),
      frequency: Object.fromEntries(PARTNER_FREQUENCIES.map((f) => [f, num(r[`freq_${f}`])])),
      snoozes: {
        last7: { taps: num(snoozes.rows[0]?.n7), owners: num(snoozes.rows[0]?.owners7) },
        last30: { taps: num(snoozes.rows[0]?.n30), owners: num(snoozes.rows[0]?.owners30) },
      },
    },
    sends: {
      kinds: SEND_KINDS.map((k) => ({ id: k, label: SEND_KIND_LABELS[k] })),
      days,
      last30: {
        sent: num(t.sent), pushReached: num(t.pushed), emailed: num(t.emailed), both: num(t.both), bellOnly: num(t.bell_only),
      },
    },
    helped: {
      opened: {
        messages: openTotal.n, opened: openTotal.opened, openedPct: pct(openTotal.opened, openTotal.n),
        clicked: openTotal.clicked, clickedPct: pct(openTotal.clicked, openTotal.n), clickedFromEmail: openTotal.clickedEmail,
        byKind: SEND_KINDS.map((k) => {
          const x = openRows.find((o) => o.kind === k) || {};
          return { id: k, label: SEND_KIND_LABELS[k], messages: num(x.n), opened: num(x.opened), openedPct: pct(num(x.opened), num(x.n)) };
        }),
      },
      cleared: {
        windowHours: MENTION_WINDOW_HOURS,
        mentioned: signals.reduce((a, s) => a + s.mentioned, 0),
        cleared: signals.reduce((a, s) => a + s.cleared, 0),
        stillOpen: signals.reduce((a, s) => a + s.stillOpen, 0),
        clearedPct: pct(signals.reduce((a, s) => a + s.cleared, 0), signals.reduce((a, s) => a + s.mentioned, 0)),
        bySignal: signals,
      },
    },
    turnOffs: {
      total: offs.length,
      medianDaysAfterSignup: offs.length >= MIN_SAMPLE ? median : null,
      bySource,
      warning: {
        countedSince: trackingSince,
        keptOn: keptN,
        turnedOff: offAfterWarningLive,
        keptPct: pct(keptN, keptN + offAfterWarningLive),
      },
    },
  };
}
