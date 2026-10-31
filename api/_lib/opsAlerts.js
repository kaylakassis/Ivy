// Operator alerting: the pieces shared by the hourly ops-alerts cron
// (api/cron/ops-alerts.js) and the Readiness page (api/admin/prod-readiness.js).
//
//   opsAlertRecipient()   who gets the emails (OPS_ALERT_EMAIL, else the
//                         first SUPER_ADMIN_EMAIL address)
//   loadCronSchedules()   the crons vercel.json actually schedules, with the
//                         window after which each one counts as overdue
//   reconcileAlerts()     the dedupe / re-notify / resolve state machine on
//                         top of ops_alert_state
//   renderOpsAlertEmail() the email itself: what, since when, the numbers,
//                         and the Admin page to open
//
// Nothing here names a vendor; these emails are operator-facing but the
// same wording rules apply everywhere.
import fs from 'node:fs';
import path from 'node:path';
import { sql } from './db.js';
import { emailShell, sendEmail } from './email.js';
import { appUrl } from './tokens.js';

export const OPS_ALERT_CRON = 'ops-alerts';
// While a condition persists, remind at most this often.
export const RENOTIFY_MS = 6 * 3600e3;
// A cron counts as overdue when it has not succeeded within these windows
// (2x its cadence, with slack for the hourly check itself).
const HOUR = 3600e3;
const DAY = 24 * HOUR;
export const STALE_HOURLY_MS = 3 * HOUR;
export const STALE_DAILY_MS = 50 * HOUR;

export function opsAlertRecipient() {
  const explicit = String(process.env.OPS_ALERT_EMAIL || '').trim();
  if (explicit) return explicit.split(/[,;\s]+/).filter(Boolean)[0] || null;
  const admins = String(process.env.SUPER_ADMIN_EMAIL || '').trim();
  if (admins) return admins.split(/[,;\s]+/).filter(Boolean)[0] || null;
  return null;
}

// ── Cron cadence ────────────────────────────────────────────────────

// Rough cadence of a 5-field cron expression: hourly-or-faster, daily
// (fixed hour or a short list of hours), or weekly-or-rarer.
export function expectedIntervalMs(schedule) {
  const parts = String(schedule || '').trim().split(/\s+/);
  if (parts.length !== 5) return DAY;
  const [, hour, dom, mon, dow] = parts;
  if (dow !== '*' || dom !== '*' || mon !== '*') return 7 * DAY;
  if (hour === '*') return HOUR;
  return DAY;
}

export function staleAfterMs(schedule) {
  const i = expectedIntervalMs(schedule);
  if (i <= HOUR) return STALE_HOURLY_MS;
  if (i <= DAY) return STALE_DAILY_MS;
  return 2 * i + 2 * HOUR;
}

export function describeInterval(schedule) {
  const i = expectedIntervalMs(schedule);
  if (i <= HOUR) return 'hourly or more often';
  if (i <= DAY) return 'daily';
  return 'weekly';
}

let cachedSchedules = null;
// [{ name, path, schedule, staleAfterMs }] for every /api/cron/* entry in
// vercel.json. Read from disk so the list can never drift from what Vercel
// actually schedules; vercel.json ships inside the cron bundles via
// functions.includeFiles.
export function loadCronSchedules() {
  if (cachedSchedules) return cachedSchedules;
  const candidates = [
    path.join(process.cwd(), 'vercel.json'),
    new URL('../../vercel.json', import.meta.url),
  ];
  for (const p of candidates) {
    try {
      const json = JSON.parse(fs.readFileSync(p, 'utf8'));
      cachedSchedules = (json.crons || [])
        .filter((c) => typeof c.path === 'string' && c.path.startsWith('/api/cron/'))
        .map((c) => ({
          name: c.path.slice('/api/cron/'.length),
          path: c.path,
          schedule: c.schedule,
          staleAfterMs: staleAfterMs(c.schedule),
        }));
      return cachedSchedules;
    } catch { /* try the next location */ }
  }
  throw new Error('vercel.json not found; cannot tell which crons are scheduled');
}

// ── State machine ───────────────────────────────────────────────────

// `firing` is the list of conditions true right now: [{ key, severity,
// title, detail, where }]. Compares against ops_alert_state and returns
// what changed. `send` is called once per email kind with the alerts it
// should carry and must resolve true when the email went out.
//
//   started   not active before (or active but never successfully
//             emailed): one "started" email, row flips active
//   reminded  active and last emailed 6+ hours ago: one reminder
//   resolved  active but no longer firing: one "Resolved" email, row
//             flips inactive
//   quiet     active, emailed recently: nothing sent, detail refreshed
export async function reconcileAlerts({ firing, send, now = new Date() }) {
  const { rows } = await sql`SELECT key, active, first_seen_at, last_notified_at, last_title, last_detail FROM ops_alert_state`;
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const firingKeys = new Set(firing.map((f) => f.key));
  const nowMs = now.getTime();

  const started = [], reminded = [], quiet = [], resolved = [];
  for (const f of firing) {
    const r = byKey.get(f.key);
    if (!r || !r.active || !r.last_notified_at) {
      started.push({ ...f, firstSeenAt: r?.active && r.first_seen_at ? r.first_seen_at : now });
    } else if (nowMs - new Date(r.last_notified_at).getTime() >= RENOTIFY_MS) {
      reminded.push({ ...f, firstSeenAt: r.first_seen_at });
    } else {
      quiet.push({ ...f, firstSeenAt: r.first_seen_at });
    }
  }
  for (const r of rows) {
    if (r.active && !firingKeys.has(r.key)) {
      resolved.push({
        key: r.key, title: r.last_title || r.key, detail: r.last_detail || '',
        firstSeenAt: r.first_seen_at, resolvedAt: now,
      });
    }
  }

  let emailed = 0;
  const deliver = async (kind, alerts) => {
    if (alerts.length === 0) return false;
    try {
      const sent = await send({ kind, alerts, now });
      if (sent) emailed++;
      return !!sent;
    } catch (err) {
      console.error(`[ops-alerts] ${kind} email failed:`, err.message);
      return false;
    }
  };

  const nowIso = now.toISOString();
  const startedSent = await deliver('started', started);
  for (const a of started) {
    await sql`
      INSERT INTO ops_alert_state (key, active, first_seen_at, last_notified_at, last_title, last_detail, updated_at)
      VALUES (${a.key}, TRUE, ${new Date(a.firstSeenAt).toISOString()}::timestamptz,
              ${startedSent ? nowIso : null}::timestamptz, ${a.title}, ${a.detail}, ${nowIso}::timestamptz)
      ON CONFLICT (key) DO UPDATE SET
        active = TRUE,
        first_seen_at = CASE WHEN ops_alert_state.active THEN ops_alert_state.first_seen_at ELSE EXCLUDED.first_seen_at END,
        last_notified_at = EXCLUDED.last_notified_at,
        last_title = EXCLUDED.last_title,
        last_detail = EXCLUDED.last_detail,
        updated_at = EXCLUDED.updated_at
    `;
  }

  const remindedSent = await deliver('reminder', reminded);
  for (const a of reminded) {
    await sql`
      UPDATE ops_alert_state SET
        last_notified_at = CASE WHEN ${remindedSent} THEN ${nowIso}::timestamptz ELSE last_notified_at END,
        last_title = ${a.title}, last_detail = ${a.detail}, updated_at = ${nowIso}::timestamptz
      WHERE key = ${a.key}
    `;
  }
  for (const a of quiet) {
    await sql`UPDATE ops_alert_state SET last_title = ${a.title}, last_detail = ${a.detail}, updated_at = ${nowIso}::timestamptz WHERE key = ${a.key}`;
  }

  // A resolved condition flips inactive whether or not the email went out;
  // retrying a "Resolved" note every hour would be its own kind of noise.
  await deliver('resolved', resolved);
  for (const a of resolved) {
    await sql`
      UPDATE ops_alert_state SET active = FALSE, last_notified_at = ${nowIso}::timestamptz, updated_at = ${nowIso}::timestamptz
      WHERE key = ${a.key}
    `;
  }

  return {
    started, reminded, quiet, resolved, emailed,
    active: [...started, ...reminded, ...quiet],
  };
}

// ── Email ───────────────────────────────────────────────────────────

const KIND_WORD = { started: 'new', reminder: 'still active', resolved: 'resolved' };

export function renderOpsAlertEmail({ kind, alerts, now = new Date() }) {
  const n = alerts.length;
  const first = alerts[0];
  let subject;
  if (kind === 'started') {
    subject = n === 1 ? `[Ivy alert] ${first.title}` : `[Ivy alert] ${n} new conditions: ${first.title}, +${n - 1} more`;
  } else if (kind === 'reminder') {
    subject = n === 1 ? `[Ivy alert] Still active: ${first.title}` : `[Ivy alert] ${n} conditions still active: ${first.title}, +${n - 1} more`;
  } else {
    subject = n === 1 ? `[Ivy alert] Resolved: ${first.title}` : `[Ivy alert] Resolved: ${n} conditions, including ${first.title}`;
  }

  const heading = kind === 'resolved'
    ? (n === 1 ? 'Resolved' : `${n} conditions resolved`)
    : (n === 1 ? first.title : `${n} conditions ${KIND_WORD[kind]}`);

  const items = alerts.map((a) => {
    const since = a.firstSeenAt ? `Since ${fmt(a.firstSeenAt)}.` : '';
    const until = kind === 'resolved' ? ` Clear as of ${fmt(a.resolvedAt || now)}.` : '';
    const sev = a.severity ? `<span style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#93A3A0;">${esc(a.severity)}</span><br/>` : '';
    const where = a.where && kind !== 'resolved' ? `<br/><span style="color:#C5D1CE;">Where to look: ${esc(a.where)}</span>` : '';
    return `<p style="margin:0 0 18px;">${sev}<strong>${esc(a.title)}</strong><br/>${esc(a.detail || '')}<br/><span style="color:#93A3A0;">${esc(since + until)}</span>${where}</p>`;
  }).join('');

  const intro = kind === 'started'
    ? `<p style="margin:0 0 18px;">The hourly check found ${n === 1 ? 'a condition that needs a look' : `${n} conditions that need a look`}. Checked at ${fmt(now)}.</p>`
    : kind === 'reminder'
      ? `<p style="margin:0 0 18px;">${n === 1 ? 'This condition is' : `These ${n} conditions are`} still present as of ${fmt(now)}. You will hear about ${n === 1 ? 'it' : 'them'} again in 6 hours if ${n === 1 ? 'it has not' : 'they have not'} cleared.</p>`
      : `<p style="margin:0 0 18px;">${n === 1 ? 'The condition below has' : `The ${n} conditions below have`} cleared. No action is needed unless you want to confirm the fix.</p>`;

  const html = emailShell({
    heading,
    preheader: alerts.map((a) => a.title).join(' | ').slice(0, 140),
    body: intro + items,
    ctaText: 'Open Admin → Readiness',
    ctaUrl: `${appUrl()}/admin?tab=readiness`,
    footer: 'Sent by the hourly operator check. You get one email when a condition starts, a reminder at most every 6 hours while it lasts, and one email when it clears. Fix the cause and the condition resolves itself on the next hourly run.',
  });
  const text = [
    heading, '',
    ...alerts.map((a) => `${a.title}\n${a.detail || ''}${a.firstSeenAt ? `\nSince ${fmt(a.firstSeenAt)}.` : ''}${a.where && kind !== 'resolved' ? `\nWhere to look: ${a.where}` : ''}`),
    '', `Open ${appUrl()}/admin?tab=readiness`,
  ].join('\n');
  return { subject, html, text };
}

// Send one alert email to the operator. Not preference-gated: this is the
// operator's own monitoring, not a product email. Returns true when the
// provider accepted it, false when there is nobody to send to.
export async function sendOpsAlertEmail({ kind, alerts, now }) {
  const to = opsAlertRecipient();
  if (!to) return false;
  const { subject, html, text } = renderOpsAlertEmail({ kind, alerts, now });
  await sendEmail({ to, subject, html, text });
  return true;
}

function fmt(d) {
  const x = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(x.getTime())) return String(d);
  return `${x.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
