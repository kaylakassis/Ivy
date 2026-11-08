// Client-facing automations from the richer client record (1.0.6):
//
//   birthday  "Happy birthday" on the client's birthday (clients.birth_month
//             + birth_day), in the owner's time zone, sent by the first
//             hourly run after 9am. At most once per client per year.
//   quiet     "We'd love to see you again" to clients quiet for N days
//             (owner-set, default 42) by the SAME rule the accountability
//             partner, the dashboard and Ivy use (quietClientWhere in
//             api/_lib/accountability.js). At most once per client per 90
//             days; never to leads, never to a client with a booking coming
//             up, never within 7 days of another automated message to them
//             (this ledger, a workflow email or text, a review request).
//
//   rebook    "Book-again link after a visit" (1.0.6): after the owner marks a
//             visit complete, the client gets the same "Ready for your next
//             {service}?" email / text as the owner's "Send rebook link"
//             button (api/_lib/rebook.js sendRebookLink), at the delay the
//             owner picks (2 hours after, next morning at 9am, or 3 days
//             after), inside the 9am to 7pm window in the business's zone.
//             Once per completed visit; never when the client has
//             something booked or a pending request, already got a rebook
//             link in the last 7 days (the owner's button, Ivy, this
//             automation or the "we'd love to see you again" message; a
//             review request does not count), was a
//             no-show or cancelled, booked a group class (capacity > 1),
//             or is blocked. The message is Ivy's fixed one, so there is no
//             template: turning it on approves it.
//
// All are OFF by default. The owner's template (plain text with
// {first_name}, {business} and {booking_link}) counts as approved when they
// save it; nothing goes out from a template the owner has not saved. Email
// goes through sendEmailToClient (type 'marketing', so the client's
// opt-outs and one-click unsubscribe apply); texts need SMS consent and
// respect quiet hours. Claim-before-send: the ledger row IS the claim
// (unique per client, kind and period), so two overlapping runs can only
// send once; a send the provider refused hands its claim back.
import { sql } from './db.js';
import { quietClientWhere, SEND_FROM_HOUR, SEND_UNTIL_HOUR } from './accountability.js';
import { isWorkspaceActive } from './clientPortal.js';
import { sendEmailToClient, sendEmail, emailShell } from './email.js';
import { fetchBranding } from './branding.js';
import { sendClientSms } from './sms.js';
import { appUrl } from './tokens.js';
import { mintRebookLink, lastServiceFor, sendRebookLink, renderRebookEmail, fmtSuggestionDay, addDaysISO, todayInZone } from './rebook.js';

export const KINDS = ['birthday', 'quiet', 'rebook'];
// The kinds whose words the owner writes (rebook uses Ivy's fixed message).
export const TEMPLATE_KINDS = ['birthday', 'quiet'];
export const KIND_LABELS = { birthday: 'Birthday message', quiet: "We'd love to see you again", rebook: 'Book-again link after a visit' };
export const ONCE_WORDS = { birthday: 'per year', quiet: 'every 90 days', rebook: 'per visit' };
// When the book-again link goes out after a visit is marked complete.
export const REBOOK_DELAYS = ['2h', 'next_morning', '3d'];
export const REBOOK_DELAY_LABELS = { '2h': '2 hours after', next_morning: 'Next morning', '3d': '3 days after' };
export const DEFAULT_REBOOK_DELAY = 'next_morning';
// A client who got any rebook link this recently is not sent another.
export const REBOOK_GAP_DAYS = 7;
// Visits completed longer ago than this are never picked up (also bounds
// the scan), and a send more than REBOOK_STALE_DAYS late is dropped.
export const REBOOK_LOOKBACK_DAYS = 7;
export const REBOOK_STALE_DAYS = 3;
// The fixed words, for the owner's card and Ivy (the email itself is
// renderRebookEmail in api/_lib/rebook.js).
export const REBOOK_MESSAGE = {
  subject: 'Ready for your next {service}?',
  text: 'Hi {first_name}, ready for your next {service} with {business}? Book again here: {booking_link}',
};
export const DEFAULT_TEMPLATES = {
  birthday: 'Happy birthday, {first_name}! Thanks for being part of {business}. Here\'s to a great year.',
  quiet: "Hi {first_name}, it's been a little while. We'd love to see you again at {business}. Book a time here: {booking_link}",
};
export const EMAIL_SUBJECTS = {
  birthday: (v) => `Happy birthday, ${v.first_name}!`,
  quiet: () => "We'd love to see you again",
};
export const DEFAULT_QUIET_DAYS = 42;
export const MIN_QUIET_DAYS = 7;
export const MAX_QUIET_DAYS = 365;
export const QUIET_REPEAT_DAYS = 90;
export const OTHER_MESSAGE_GAP_DAYS = 7;
export const MAX_TEMPLATE_CHARS = 600;
export const MERGE_FIELDS = ['first_name', 'business', 'booking_link'];
export const MERGE_FIELD_HELP = {
  first_name: "the client's first name",
  business: 'your business name',
  booking_link: 'a link to book (their usual service when they have one)',
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── templates ──────────────────────────────────────────────────────────
export function templateProblems(template) {
  const t = String(template ?? '');
  if (!t.trim()) return 'Write the message first';
  if (t.length > MAX_TEMPLATE_CHARS) return `Keep the message under ${MAX_TEMPLATE_CHARS} characters`;
  const unknown = [...t.matchAll(/\{([a-zA-Z_][\w ]*)\}/g)].map((m) => m[1]).filter((k) => !MERGE_FIELDS.includes(k));
  if (unknown.length) return `Only {first_name}, {business} and {booking_link} can be filled in. Not: {${unknown[0]}}`;
  if (/<[a-z/!][^>]*>/i.test(t)) return 'Plain text only, no HTML';
  return null;
}

export function renderTemplate(template, vars) {
  return String(template || '').replace(/\{(first_name|business|booking_link)\}/g, (_, k) => (vars[k] == null ? '' : String(vars[k])));
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const firstNameOf = (s) => String(s || '').trim().split(/\s+/)[0] || 'there';

// Text → email paragraphs, with the booking link as a real link.
export function templateHtml(template, vars) {
  const marker = '\u0000link\u0000';
  const text = renderTemplate(template, { ...vars, booking_link: vars.booking_link ? marker : '' });
  // The link reads as the short booking-page address (the signed part
  // would stretch the email); the href carries the whole link.
  const shown = String(vars.booking_link || '').split('?')[0].replace(/^https?:\/\//, '');
  const safe = escapeHtml(text).split(marker).join(vars.booking_link
    ? `<a href="${escapeHtml(vars.booking_link)}" style="color:#4E63C7;font-weight:600;word-break:break-all;">${escapeHtml(shown)}</a>` : '');
  return `<p>${safe.replace(/\n\n+/g, '</p><p>').replace(/\n/g, '<br/>')}</p>`;
}

// The email for one automation (also the admin email preview,
// api/admin/email-preview.js). → { subject, html }
export function renderAutomationEmail({ kind, template, vars, branding, footer }) {
  const subject = EMAIL_SUBJECTS[kind](vars);
  const withCta = (kind === 'quiet' || String(template).includes('{booking_link}')) && !!vars.booking_link;
  return {
    subject,
    html: emailShell({
      heading: subject,
      body: templateHtml(template, vars),
      ctaText: withCta ? 'Book a time' : null,
      ctaUrl: withCta ? vars.booking_link : null,
      footer: footer ?? `Sent by ${escapeHtml(vars.business)}.`,
      branding,
    }),
  };
}

// ── settings ───────────────────────────────────────────────────────────
function serialize(kind, row, extra = {}) {
  const rebook = kind === 'rebook';
  const delay = REBOOK_DELAYS.includes(row?.rebook_delay) ? row.rebook_delay : DEFAULT_REBOOK_DELAY;
  return {
    kind,
    label: KIND_LABELS[kind],
    enabled: !!row?.enabled,
    template: rebook ? null : (row?.template ?? DEFAULT_TEMPLATES[kind]),
    defaultTemplate: rebook ? null : DEFAULT_TEMPLATES[kind],
    channels: { email: row?.channels?.email !== false, sms: !!row?.channels?.sms },
    quietDays: kind === 'quiet' ? Number(row?.quiet_days || DEFAULT_QUIET_DAYS) : null,
    templateApprovedAt: row?.template_approved_at || null,
    once: ONCE_WORDS[kind],
    note: rebook
      ? 'Ivy sends this for you. Each client gets it once per visit, never if they already have something booked.'
      : `Ivy sends this for you. Each client gets it at most once ${ONCE_WORDS[kind]}.`,
    sentThisMonth: Number(extra.sentThisMonth || 0),
    lastSentAt: extra.lastSentAt || null,
    ...(rebook ? {
      delay,
      delayLabel: REBOOK_DELAY_LABELS[delay],
      delayOptions: REBOOK_DELAYS.map((value) => ({ value, label: REBOOK_DELAY_LABELS[value] })),
      fixedMessage: REBOOK_MESSAGE,
    } : {}),
  };
}

export async function readAutomations(workspaceId) {
  const [rows, sent] = await Promise.all([
    sql`SELECT * FROM client_automations WHERE workspace_id = ${workspaceId}`,
    sql`SELECT kind, COUNT(*) FILTER (WHERE sent_at >= date_trunc('month', NOW()))::int AS month, MAX(sent_at) AS last
          FROM client_automation_sends WHERE workspace_id = ${workspaceId} AND sent_at IS NOT NULL GROUP BY kind`,
  ]);
  const out = {};
  for (const kind of KINDS) {
    const row = rows.rows.find((r) => r.kind === kind) || null;
    const s = sent.rows.find((r) => r.kind === kind);
    out[kind] = serialize(kind, row, { sentThisMonth: s?.month, lastSentAt: s?.last });
  }
  return out;
}

// Validates and saves one kind. Saving a template approves it. Turning on
// needs an approved template (a template in the same patch counts).
export function cleanAutomationPatch(kind, patch) {
  if (!KINDS.includes(kind)) throw new Error('kind must be birthday, quiet or rebook');
  const p = patch && typeof patch === 'object' ? patch : {};
  const out = {};
  if ('enabled' in p) {
    if (typeof p.enabled !== 'boolean') throw new Error('enabled must be true or false');
    out.enabled = p.enabled;
  }
  if ('template' in p && kind === 'rebook') {
    // Older callers may send the template they hold; nothing to save.
    if (p.template != null && String(p.template).trim()) throw new Error('The book-again message is written for you, so there is nothing to edit');
  } else if ('template' in p) {
    const problem = templateProblems(p.template);
    if (problem) throw new Error(problem);
    out.template = String(p.template).trim();
  }
  if ('channels' in p) {
    const c = p.channels && typeof p.channels === 'object' ? p.channels : {};
    const email = c.email == null ? true : !!c.email;
    const sms = !!c.sms;
    if (!email && !sms) throw new Error('Choose email, text, or both');
    out.channels = { email, sms };
  }
  if ('quietDays' in p || 'quiet_days' in p) {
    if (kind !== 'quiet') throw new Error('quietDays only applies to the "We\'d love to see you again" message');
    const n = Number(p.quietDays ?? p.quiet_days);
    if (!Number.isInteger(n) || n < MIN_QUIET_DAYS || n > MAX_QUIET_DAYS) throw new Error(`Quiet days must be a whole number from ${MIN_QUIET_DAYS} to ${MAX_QUIET_DAYS}`);
    out.quietDays = n;
  }
  if ('delay' in p) {
    if (kind !== 'rebook') throw new Error('delay only applies to the book-again link');
    if (!REBOOK_DELAYS.includes(p.delay)) throw new Error('delay must be 2h, next_morning or 3d');
    out.delay = p.delay;
  }
  if (!Object.keys(out).length) throw new Error('Nothing to change');
  return out;
}

export async function saveAutomation(workspaceId, kind, patch) {
  const clean = cleanAutomationPatch(kind, patch);
  const cur = (await sql`SELECT * FROM client_automations WHERE workspace_id = ${workspaceId} AND kind = ${kind}`).rows[0] || null;
  // The book-again link is Ivy's fixed message: saving the card approves it.
  const rebook = kind === 'rebook';
  const approved = rebook || clean.template != null || !!cur?.template_approved_at;
  if (clean.enabled === true && !approved) throw new Error('Save the message first, then turn it on');
  const channels = clean.channels || (cur?.channels ?? { email: true, sms: false });
  const enabled = clean.enabled ?? cur?.enabled ?? false;
  const nowIso = new Date().toISOString();
  // enabled_at: when it was last switched on (the rebook automation never
  // looks at visits completed before that).
  const enabledAt = enabled ? (cur?.enabled ? (cur.enabled_at || cur.updated_at || nowIso) : nowIso) : (cur?.enabled_at || null);
  const approvedAt = clean.template != null || (rebook && !cur?.template_approved_at) ? nowIso : (cur?.template_approved_at || null);
  const row = (await sql`
    INSERT INTO client_automations (workspace_id, kind, enabled, template, channels, quiet_days, template_approved_at, rebook_delay, enabled_at)
    VALUES (${workspaceId}, ${kind}, ${enabled},
            ${rebook ? null : (clean.template ?? cur?.template ?? null)},
            ${JSON.stringify(channels)}::jsonb,
            ${clean.quietDays ?? cur?.quiet_days ?? DEFAULT_QUIET_DAYS},
            ${approvedAt},
            ${clean.delay ?? cur?.rebook_delay ?? DEFAULT_REBOOK_DELAY},
            ${enabledAt})
    ON CONFLICT (workspace_id, kind) DO UPDATE SET
      enabled = EXCLUDED.enabled, template = EXCLUDED.template, channels = EXCLUDED.channels,
      quiet_days = EXCLUDED.quiet_days, template_approved_at = EXCLUDED.template_approved_at,
      rebook_delay = EXCLUDED.rebook_delay, enabled_at = EXCLUDED.enabled_at, updated_at = NOW()
    RETURNING *`).rows[0];
  return { row: serialize(kind, row), changed: clean, before: cur ? serialize(kind, cur) : serialize(kind, null) };
}

// ── who is due ─────────────────────────────────────────────────────────
// cs.timezone is checked against pg_timezone_names so an unknown name can
// never throw (falls back to UTC). Never inline it into AT TIME ZONE.
const LOCAL = `(NOW() AT TIME ZONE COALESCE(z.name, 'UTC'))`;
const WS_FROM = `
  FROM client_automations a
  JOIN workspaces w ON w.id = a.workspace_id
  JOIN users u ON u.id = w.owner_id AND u.deleted_at IS NULL
  LEFT JOIN calendar_settings cs ON cs.workspace_id = w.id
  LEFT JOIN pg_timezone_names z ON z.name = cs.timezone`;
const WS_COLS = `
  w.id AS workspace_id, COALESCE(z.name, 'UTC') AS tz, ${LOCAL} AS local_now,
  cs.slug, cs.biz_name, a.kind, a.template, a.channels, a.quiet_days, a.rebook_delay, a.enabled_at,
  w.subscription_status, w.trial_ends_at, w.subscription_period_end, w.comp_until`;

// Not a leap year → a Feb 29 birthday is celebrated on Feb 28.
const BIRTHDAY_TODAY = `(
  (c.birth_month = EXTRACT(MONTH FROM ws.local_now)::int AND c.birth_day = EXTRACT(DAY FROM ws.local_now)::int)
  OR (c.birth_month = 2 AND c.birth_day = 29
      AND EXTRACT(MONTH FROM ws.local_now)::int = 2 AND EXTRACT(DAY FROM ws.local_now)::int = 28
      AND NOT (EXTRACT(YEAR FROM ws.local_now)::int % 4 = 0
               AND (EXTRACT(YEAR FROM ws.local_now)::int % 100 <> 0 OR EXTRACT(YEAR FROM ws.local_now)::int % 400 = 0)))
)`;
const REACHABLE = `((c.email IS NOT NULL AND c.email <> '') OR (c.phone IS NOT NULL AND c.sms_consent_at IS NOT NULL AND c.sms_stopped_at IS NULL))`;
const NOT_BLOCKED = `NOT EXISTS (SELECT 1 FROM contact_blocks cb WHERE cb.workspace_id = c.workspace_id AND cb.client_id = c.id)`;

// Enabled, approved automations of one kind whose owner's local time is in
// the sending window. `inWindow: false` lists them regardless (for "who is
// due this week"). Activity (plan or trial) is decided in JS.
export async function enabledWorkspaces(kind, { shardFilter = '', inWindow = true, workspaceId = null } = {}) {
  const params = [kind];
  let where = `a.kind = $1 AND a.enabled = TRUE AND a.template_approved_at IS NOT NULL AND w.data_purged_at IS NULL`;
  if (inWindow) where += ` AND EXTRACT(HOUR FROM ${LOCAL})::int >= ${SEND_FROM_HOUR} AND EXTRACT(HOUR FROM ${LOCAL})::int < ${SEND_UNTIL_HOUR}`;
  if (workspaceId) { params.push(workspaceId); where += ` AND w.id = $${params.length}`; }
  const { rows } = await sql.query(`SELECT ${WS_COLS} ${WS_FROM} WHERE ${where} ${shardFilter} ORDER BY w.id`, params);
  return rows.filter((r) => isWorkspaceActive(r));
}

// Birthday clients of one workspace row from enabledWorkspaces (today in the
// owner's zone, not yet sent this year).
export async function dueBirthdayClients(ws, { limit = 200 } = {}) {
  const { rows } = await sql.query(
    `WITH ws AS (SELECT $1::uuid AS workspace_id, (NOW() AT TIME ZONE $2) AS local_now)
     SELECT c.id AS client_id, c.name, c.email, c.phone, c.sms_consent_at, c.sms_stopped_at,
            to_char(ws.local_now, 'YYYY') AS period_key
       FROM ws JOIN clients c ON c.workspace_id = ws.workspace_id
      WHERE c.stage <> 'lead' AND c.source IS DISTINCT FROM 'demo'
        AND c.birth_month IS NOT NULL AND c.birth_day IS NOT NULL
        AND ${BIRTHDAY_TODAY}
        AND ${REACHABLE} AND ${NOT_BLOCKED}
        AND NOT EXISTS (SELECT 1 FROM client_automation_sends s
                         WHERE s.workspace_id = c.workspace_id AND s.client_id = c.id
                           AND s.kind = 'birthday' AND s.period_key = to_char(ws.local_now, 'YYYY'))
      ORDER BY c.created_at ASC LIMIT $3`,
    [ws.workspace_id, ws.tz, Math.max(1, Math.min(500, limit))],
  );
  return rows;
}

// The exclusions on top of the shared quiet rule.
const QUIET_EXTRA = `
  AND ${REACHABLE} AND ${NOT_BLOCKED}
  AND NOT EXISTS (SELECT 1 FROM client_automation_sends s
                   WHERE s.workspace_id = c.workspace_id AND s.client_id = c.id
                     AND s.kind = 'quiet' AND s.claimed_at > NOW() - INTERVAL '${QUIET_REPEAT_DAYS} days')
  AND NOT EXISTS (SELECT 1 FROM client_automation_sends s
                   WHERE s.workspace_id = c.workspace_id AND s.client_id = c.id
                     AND s.claimed_at > NOW() - INTERVAL '${OTHER_MESSAGE_GAP_DAYS} days')
  AND NOT EXISTS (SELECT 1 FROM workflow_runs wr
                   WHERE wr.workspace_id = c.workspace_id AND wr.client_id = c.id
                     AND wr.triggered_at > NOW() - INTERVAL '${OTHER_MESSAGE_GAP_DAYS} days'
                     AND wr.status IN ('succeeded', 'partial', 'waiting')
                     AND (wr.action_results @> '[{"type": "send_email", "status": "ok"}]'::jsonb
                          OR wr.action_results @> '[{"type": "send_sms", "status": "ok"}]'::jsonb))
  AND NOT EXISTS (SELECT 1 FROM bookings rb
                   WHERE rb.workspace_id = c.workspace_id AND rb.client_id = c.id
                     AND rb.review_requested_at > NOW() - INTERVAL '${OTHER_MESSAGE_GAP_DAYS} days')`;

export async function dueQuietClients(ws, { limit = 200 } = {}) {
  const days = Number(ws.quiet_days) || DEFAULT_QUIET_DAYS;
  const { rows } = await sql.query(
    `SELECT c.id AS client_id, c.name, c.email, c.phone, c.sms_consent_at, c.sms_stopped_at,
            to_char(NOW() AT TIME ZONE $3, 'YYYY-MM-DD') AS period_key
       FROM clients c
      WHERE ${quietClientWhere(days)} ${QUIET_EXTRA}
      ORDER BY c.created_at ASC LIMIT $2`,
    [ws.workspace_id, Math.max(1, Math.min(500, limit)), ws.tz || 'UTC'],
  );
  return rows;
}

// ── book-again link after a visit ──────────────────────────────────────
// One row per completed visit (a completion_log occurrence) whose client
// should get the link, with when it is due. `mode`:
//   'due'      due now (due_at has passed, not more than REBOOK_STALE_DAYS
//              ago): what the hourly run sends;
//   'upcoming' every visit that will get one (due or not yet), for the
//              owner's card and Ivy.
// `since`: visits completed before this are ignored (when the switch went
// on, never more than REBOOK_LOOKBACK_DAYS back). One row per client (the
// latest visit), so two visits on one day still send one link.
const REBOOK_DUE_AT = `(CASE ws.delay
    WHEN '2h' THEN ca.completed_at + INTERVAL '2 hours'
    WHEN '3d' THEN ca.completed_at + INTERVAL '3 days'
    ELSE (((ca.completed_at AT TIME ZONE ws.tz)::date + 1) + TIME '09:00') AT TIME ZONE ws.tz
  END)`;
export async function dueRebookVisits(ws, { mode = 'due', since = null, limit = 200 } = {}) {
  const delay = REBOOK_DELAYS.includes(ws.rebook_delay) ? ws.rebook_delay : DEFAULT_REBOOK_DELAY;
  const floor = new Date(Date.now() - REBOOK_LOOKBACK_DAYS * 86400000);
  const from = since && new Date(since) > floor ? new Date(since) : floor;
  const dueWhere = mode === 'due'
    ? `AND v.due_at <= NOW() AND v.due_at > NOW() - INTERVAL '${REBOOK_STALE_DAYS} days'`
    : '';
  const { rows } = await sql.query(
    `WITH ws AS (SELECT $1::uuid AS workspace_id, $2::text AS tz, $3::text AS delay, $4::timestamptz AS since,
                        (NOW() AT TIME ZONE $2)::date AS local_today,
                        (EXTRACT(HOUR FROM NOW() AT TIME ZONE $2) * 60 + EXTRACT(MINUTE FROM NOW() AT TIME ZONE $2))::int AS local_min),
     v AS (
       SELECT DISTINCT ON (c.id)
              c.id AS client_id, c.name, c.email, c.phone, c.sms_consent_at, c.sms_stopped_at,
              b.id AS booking_id, b.service_id, s.name AS service_name, occ.key AS occurrence_date,
              ca.completed_at, ${REBOOK_DUE_AT} AS due_at,
              b.id::text || ':' || occ.key AS period_key
         FROM ws
         JOIN bookings b ON b.workspace_id = ws.workspace_id
         JOIN LATERAL jsonb_each(COALESCE(b.completion_log, '{}'::jsonb)) AS occ(key, val) ON TRUE
         CROSS JOIN LATERAL (SELECT CASE WHEN (occ.val->>'completedAt') ~ '^\\d{4}-\\d{2}-\\d{2}T'
                                         THEN (occ.val->>'completedAt')::timestamptz END AS completed_at) ca
         JOIN clients c ON c.id = b.client_id AND c.workspace_id = b.workspace_id
         JOIN services s ON s.id = b.service_id AND s.workspace_id = b.workspace_id
        WHERE b.completion_log <> '{}'::jsonb
          AND b.cancelled_at IS NULL AND b.no_show_at IS NULL
          AND (b.requested_at IS NULL OR b.request_decided_at IS NOT NULL)
          AND occ.key ~ '^\\d{4}-\\d{2}-\\d{2}$'
          AND NOT (occ.key = ANY (SELECT to_char(d, 'YYYY-MM-DD') FROM unnest(b.cancelled_occurrences) d))
          AND ca.completed_at IS NOT NULL AND ca.completed_at >= ws.since
          -- group classes (more than one client per slot) are not "your next visit"
          AND COALESCE(s.capacity, 1) <= 1 AND s.visibility <> 'only_me'
          AND c.stage <> 'paused' AND c.source IS DISTINCT FROM 'demo'
          AND ${REACHABLE} AND ${NOT_BLOCKED}
          -- this visit was already handled (sent, or kept as unreachable)
          AND NOT EXISTS (SELECT 1 FROM client_automation_sends x
                           WHERE x.workspace_id = c.workspace_id AND x.client_id = c.id
                             AND x.kind = 'rebook' AND x.period_key = b.id::text || ':' || occ.key)
          -- something booked: a later booking, a pending request or a repeating series
          AND NOT EXISTS (SELECT 1 FROM bookings fb
                           WHERE fb.workspace_id = c.workspace_id AND fb.client_id = c.id AND fb.cancelled_at IS NULL
                             AND ((fb.id <> b.id AND (fb.date > ws.local_today
                                                      OR (fb.date = ws.local_today AND fb.start_min > ws.local_min)))
                                  OR (fb.recurrence_rule IS NOT NULL
                                      AND (fb.recurrence_until IS NULL OR fb.recurrence_until >= ws.local_today))))
          -- any rebook link in the last ${REBOOK_GAP_DAYS} days: the owner's button or Ivy
          -- (rebook_link_sent_at), this automation or the check-in (ledger).
          -- A review request does not count: the owner turned this on so
          -- the client gets the book-again email itself (Kayla, 1.0.6).
          AND NOT EXISTS (SELECT 1 FROM bookings rb
                           WHERE rb.workspace_id = c.workspace_id AND rb.client_id = c.id
                             AND rb.rebook_link_sent_at > NOW() - INTERVAL '${REBOOK_GAP_DAYS} days')
          AND NOT EXISTS (SELECT 1 FROM client_automation_sends y
                           WHERE y.workspace_id = c.workspace_id AND y.client_id = c.id
                             AND y.kind IN ('rebook', 'quiet')
                             AND y.claimed_at > NOW() - INTERVAL '${REBOOK_GAP_DAYS} days')
        ORDER BY c.id, ca.completed_at DESC
     )
     SELECT v.*, w2.sends_at,
            CASE WHEN w2.sends_at <= NOW() THEN 'within the hour'
                 ELSE to_char(w2.sends_at AT TIME ZONE $2, 'FMDy, FMMon FMDD "at" FMHH12:MI am') END AS sends_at_label
       FROM v
       -- when it actually goes out: the due time moved into the 9am to 7pm window
       CROSS JOIN LATERAL (SELECT CASE
           WHEN EXTRACT(HOUR FROM v.due_at AT TIME ZONE $2) < ${SEND_FROM_HOUR}
             THEN ((v.due_at AT TIME ZONE $2)::date + make_time(${SEND_FROM_HOUR}, 0, 0)) AT TIME ZONE $2
           WHEN EXTRACT(HOUR FROM v.due_at AT TIME ZONE $2) >= ${SEND_UNTIL_HOUR}
             THEN ((v.due_at AT TIME ZONE $2)::date + 1 + make_time(${SEND_FROM_HOUR}, 0, 0)) AT TIME ZONE $2
           ELSE v.due_at END AS sends_at) w2
      WHERE TRUE ${dueWhere} ORDER BY v.due_at ASC LIMIT $5`,
    [ws.workspace_id, ws.tz || 'UTC', delay, from.toISOString(), Math.max(1, Math.min(500, limit))],
  );
  return rows;
}

// For the owner screen and Ivy: birthdays in the next 7 days (owner zone)
// and the clients the quiet message would go to on its next run. Only the
// automations that are on; off ones show what WOULD be due, flagged.
export async function dueThisWeek(workspaceId) {
  const cfg = await readAutomations(workspaceId);
  const tzRow = (await sql`
    SELECT COALESCE(z.name, 'UTC') AS tz FROM calendar_settings cs
      LEFT JOIN pg_timezone_names z ON z.name = cs.timezone WHERE cs.workspace_id = ${workspaceId}`).rows[0];
  const tz = tzRow?.tz || 'UTC';
  const b = await sql.query(
    `WITH d AS (SELECT (NOW() AT TIME ZONE $2)::date + g AS day FROM generate_series(0, 6) g)
     SELECT c.id, c.name, to_char(d.day, 'YYYY-MM-DD') AS day
       FROM clients c JOIN d ON (c.birth_month = EXTRACT(MONTH FROM d.day)::int AND c.birth_day = EXTRACT(DAY FROM d.day)::int)
      WHERE c.workspace_id = $1 AND c.stage <> 'lead' AND c.source IS DISTINCT FROM 'demo'
        AND ${REACHABLE} AND ${NOT_BLOCKED}
        AND NOT EXISTS (SELECT 1 FROM client_automation_sends s
                         WHERE s.workspace_id = c.workspace_id AND s.client_id = c.id
                           AND s.kind = 'birthday' AND s.period_key = to_char(d.day, 'YYYY'))
      ORDER BY d.day, c.name LIMIT 50`,
    [workspaceId, tz],
  );
  const q = await dueQuietClients({ workspace_id: workspaceId, tz, quiet_days: cfg.quiet.quietDays }, { limit: 50 });
  // Book-again: on → the visits since it went on that will get the link
  // (due now or later); off → the last few days' visits that WOULD.
  const rbRow = (await sql`SELECT enabled_at FROM client_automations WHERE workspace_id = ${workspaceId} AND kind = 'rebook'`).rows[0];
  const r = await dueRebookVisits(
    { workspace_id: workspaceId, tz, rebook_delay: cfg.rebook.delay },
    { mode: 'upcoming', since: cfg.rebook.enabled ? (rbRow?.enabled_at || null) : new Date(Date.now() - REBOOK_STALE_DAYS * 86400000), limit: 50 },
  ).catch(() => []);
  return {
    birthday: { enabled: cfg.birthday.enabled, clients: b.rows.map((x) => ({ clientId: x.id, name: x.name, day: x.day })) },
    quiet: { enabled: cfg.quiet.enabled, quietDays: cfg.quiet.quietDays, count: q.length, clients: q.map((x) => ({ clientId: x.client_id, name: x.name })) },
    rebook: {
      enabled: cfg.rebook.enabled, delay: cfg.rebook.delay, count: r.length,
      clients: r.map((x) => ({
        clientId: x.client_id, name: x.name, service: x.service_name, bookingId: x.booking_id,
        dueAt: x.due_at instanceof Date ? x.due_at.toISOString() : x.due_at,
        sendsAt: x.sends_at instanceof Date ? x.sends_at.toISOString() : x.sends_at,
        sendsAtLabel: x.sends_at_label || null,
      })),
    },
  };
}

// ── sending ────────────────────────────────────────────────────────────
// The claim: one ledger row per client, kind and period. null = already claimed.
export async function claimSend({ workspaceId, clientId, kind, periodKey }) {
  const { rows } = await sql`
    INSERT INTO client_automation_sends (workspace_id, client_id, kind, period_key)
    VALUES (${workspaceId}, ${clientId}, ${kind}, ${periodKey})
    ON CONFLICT (workspace_id, client_id, kind, period_key) DO NOTHING
    RETURNING id`;
  return rows[0]?.id || null;
}
export async function releaseClaim(id) {
  if (id) await sql`DELETE FROM client_automation_sends WHERE id = ${id}`.catch(() => {});
}

// The merge values for one client, with the rebook link when they have a
// past service, else the public booking page, else no link.
export async function mergeValuesFor({ workspaceId, client, slug, businessName }) {
  let bookingLink = slug ? `${appUrl()}/book/${encodeURIComponent(slug)}` : '';
  if (slug && client?.client_id) {
    try {
      const last = await lastServiceFor({ workspaceId, clientId: client.client_id });
      if (last) {
        const link = await mintRebookLink({ workspaceId, clientId: client.client_id, serviceId: last.serviceId, slug });
        if (link) bookingLink = link.url;
      }
    } catch { /* plain booking page */ }
  }
  return { first_name: firstNameOf(client?.name), business: businessName, booking_link: bookingLink };
}

// Email and/or text one client. Returns { emailed, texted, emailReason, smsReason, retry }
// where retry says a failure was the provider's (hand the claim back).
export async function deliverAutomation({ ws, kind, client, branding = null }) {
  const b = branding || await fetchBranding(ws.workspace_id).catch(() => ({}));
  const business = b.businessName || ws.biz_name || 'us';
  const vars = await mergeValuesFor({ workspaceId: ws.workspace_id, client, slug: ws.slug, businessName: business });
  const template = ws.template || DEFAULT_TEMPLATES[kind];
  const channels = { email: ws.channels?.email !== false, sms: !!ws.channels?.sms };
  const out = { emailed: false, texted: false, emailReason: null, smsReason: null, retry: false };
  // A reason that will not change by trying again (the claim is kept, so
  // the client is not asked again this period); anything else is retried.
  const HARD = new Set(['muted', 'no email', 'no phone', 'no consent', 'twilio not configured', 'invalid phone']);

  if (channels.email) {
    if (!client.email) out.emailReason = 'no email';
    else {
      const mail = renderAutomationEmail({ kind, template, vars, branding: b });
      const r = await sendEmailToClient({
        clientId: client.client_id, workspaceId: ws.workspace_id, type: 'marketing', to: client.email,
        subject: mail.subject, replyTo: b.replyTo, html: mail.html,
      }).catch((e) => ({ ok: false, sent: false, reason: e?.message || 'send failed' }));
      out.emailed = !!r?.sent;
      if (!out.emailed) out.emailReason = r?.reason || 'send failed';
    }
  }
  if (channels.sms) {
    if (!client.phone) out.smsReason = 'no phone';
    else if (!client.sms_consent_at || client.sms_stopped_at) out.smsReason = 'no consent';
    else {
      const r = await sendClientSms({
        workspaceId: ws.workspace_id, phone: client.phone, consentAt: client.sms_consent_at, respectQuietHours: true,
        body: renderTemplate(template, vars),
      });
      out.texted = !!r.ok;
      if (!out.texted) out.smsReason = r.reason || 'send failed';
    }
  }
  if (!out.emailed && !out.texted) {
    const soft = (chosen, reason) => chosen && reason && !HARD.has(reason);
    out.retry = soft(channels.email, out.emailReason) || soft(channels.sms, out.smsReason);
  }
  return out;
}

// The book-again link for one completed visit, through the same path as the
// owner's "Send rebook link" button (sendRebookLink: email opt-outs, SMS
// consent and STOP, contact blocks, quiet hours for texts), on the channels
// the owner chose. It records rebook_link_sent_at on the visit like the
// button does. Same result shape as deliverAutomation.
const REBOOK_HARD = new Set(['muted', 'no email', 'no phone', 'no consent', 'twilio not configured', 'invalid phone', 'not chosen']);
export async function deliverRebook({ ws, visit }) {
  const channels = { email: ws.channels?.email !== false, sms: !!ws.channels?.sms };
  const r = await sendRebookLink({
    workspaceId: ws.workspace_id, clientId: visit.client_id, serviceId: visit.service_id,
    bookingId: visit.booking_id, channels,
  });
  const out = { emailed: !!r.emailed, texted: !!r.texted, emailReason: r.emailCode || r.emailReason || null, smsReason: r.smsCode || r.smsReason || null, retry: false };
  if (r.error) { out.emailReason = out.emailReason || r.error; return out; } // no booking page, service gone: nothing to retry
  if (!out.emailed && !out.texted) {
    const soft = (chosen, code) => chosen && code && !REBOOK_HARD.has(code);
    out.retry = soft(channels.email, r.emailCode) || soft(channels.sms, r.smsCode);
  }
  return out;
}

async function runRebookForWorkspace(ws, { deadline, perWorkspaceCap, counts }) {
  const visits = await dueRebookVisits(ws, { mode: 'due', since: ws.enabled_at || null, limit: perWorkspaceCap });
  for (const v of visits) {
    if (Date.now() >= deadline) return 'deadline';
    counts.considered++;
    const claim = await claimSend({ workspaceId: ws.workspace_id, clientId: v.client_id, kind: 'rebook', periodKey: v.period_key });
    if (!claim) { counts.skipped++; continue; }
    // Two visits of one client claimed by two runs at the same moment: only
    // one link. Any other claim this week wins; ours is handed back.
    const other = await sql`
      SELECT 1 FROM client_automation_sends
       WHERE workspace_id = ${ws.workspace_id} AND client_id = ${v.client_id} AND kind IN ('rebook', 'quiet')
         AND id <> ${claim} AND claimed_at > NOW() - make_interval(days => ${REBOOK_GAP_DAYS}) LIMIT 1`;
    if (other.rows.length) { await releaseClaim(claim); counts.skipped++; continue; }
    await sql`UPDATE client_automation_sends SET booking_id = ${v.booking_id} WHERE id = ${claim}`.catch(() => {});
    try {
      const r = await deliverRebook({ ws, visit: v });
      if (r.emailed || r.texted) {
        await sql`UPDATE client_automation_sends SET sent_at = NOW(), emailed = ${r.emailed}, texted = ${r.texted} WHERE id = ${claim}`;
        counts.sent++;
        if (r.emailed) counts.emailed++;
        if (r.texted) counts.texted++;
      } else if (r.retry) {
        await releaseClaim(claim);
        counts.retried++;
      } else {
        counts.skipped++;
      }
    } catch (err) {
      await releaseClaim(claim);
      counts.failed++;
      console.error('[client-automations] rebook send failed for', v.client_id, err.message);
    }
  }
  return null;
}

// The cron's loop: every enabled automation in the sending window, each due
// client claimed then delivered. Stops at `deadline`.
export async function runClientAutomations({ shardFilter = '', deadline = Infinity, perWorkspaceCap = 200, workspaceId = null, inWindow = true } = {}) {
  const counts = { workspaces: 0, considered: 0, sent: 0, emailed: 0, texted: 0, skipped: 0, retried: 0, failed: 0 };
  for (const kind of KINDS) {
    const wss = await enabledWorkspaces(kind, { shardFilter, workspaceId, inWindow });
    for (const ws of wss) {
      if (Date.now() >= deadline) return { ...counts, terminatedBy: 'deadline' };
      counts.workspaces++;
      if (kind === 'rebook') {
        try {
          if (await runRebookForWorkspace(ws, { deadline, perWorkspaceCap, counts }) === 'deadline') return { ...counts, terminatedBy: 'deadline' };
        } catch (err) {
          console.error('[client-automations] rebook candidates failed for', ws.workspace_id, err.message);
          counts.failed++;
        }
        continue;
      }
      let clients;
      try {
        clients = kind === 'birthday' ? await dueBirthdayClients(ws, { limit: perWorkspaceCap }) : await dueQuietClients(ws, { limit: perWorkspaceCap });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[client-automations] ${kind} candidates failed for`, ws.workspace_id, err.message);
        counts.failed++;
        continue;
      }
      const branding = await fetchBranding(ws.workspace_id).catch(() => ({}));
      for (const c of clients) {
        if (Date.now() >= deadline) return { ...counts, terminatedBy: 'deadline' };
        counts.considered++;
        const claim = await claimSend({ workspaceId: ws.workspace_id, clientId: c.client_id, kind, periodKey: c.period_key });
        if (!claim) { counts.skipped++; continue; }
        try {
          const r = await deliverAutomation({ ws, kind, client: c, branding });
          if (r.emailed || r.texted) {
            await sql`UPDATE client_automation_sends SET sent_at = NOW(), emailed = ${r.emailed}, texted = ${r.texted} WHERE id = ${claim}`;
            counts.sent++;
            if (r.emailed) counts.emailed++;
            if (r.texted) counts.texted++;
          } else if (r.retry) {
            await releaseClaim(claim);
            counts.retried++;
          } else {
            counts.skipped++; // unreachable (opted out / no consent): claim kept, no nagging
          }
        } catch (err) {
          await releaseClaim(claim);
          counts.failed++;
          // eslint-disable-next-line no-console
          console.error(`[client-automations] ${kind} send failed for`, c.client_id, err.message);
        }
      }
    }
  }
  return { ...counts, terminatedBy: 'empty' };
}

// "Send me a test": the owner's own inbox, with sample values. Not recorded.
export async function sendTestAutomation({ workspaceId, kind, to, ownerName, template = null }) {
  if (!KINDS.includes(kind)) throw new Error('kind must be birthday, quiet or rebook');
  if (!to) throw new Error('Your account has no email address');
  if (kind === 'rebook') return sendTestRebook({ workspaceId, to, ownerName });
  const tpl = template != null ? template : ((await sql`SELECT template FROM client_automations WHERE workspace_id = ${workspaceId} AND kind = ${kind}`).rows[0]?.template || DEFAULT_TEMPLATES[kind]);
  const problem = templateProblems(tpl);
  if (problem) throw new Error(problem);
  const b = await fetchBranding(workspaceId).catch(() => ({}));
  const cs = (await sql`SELECT slug FROM calendar_settings WHERE workspace_id = ${workspaceId}`).rows[0];
  const business = b.businessName || 'your business';
  const vars = { first_name: firstNameOf(ownerName), business, booking_link: cs?.slug ? `${appUrl()}/book/${encodeURIComponent(cs.slug)}` : '' };
  const mail = renderAutomationEmail({
    kind, template: tpl, vars, branding: b,
    footer: 'This is a test of your automated message. Clients see their own first name and, when they have one, a link to book their usual service again.',
  });
  await sendEmail({ to, subject: `[Test] ${mail.subject}`, html: mail.html });
  return { to, subject: mail.subject };
}

// The book-again test: the real email with the business's first service and
// a sample day two weeks out at 10am. The button opens the booking page.
async function sendTestRebook({ workspaceId, to, ownerName }) {
  const b = await fetchBranding(workspaceId).catch(() => ({}));
  const cs = (await sql`SELECT slug, timezone FROM calendar_settings WHERE workspace_id = ${workspaceId}`).rows[0];
  const svc = (await sql`
    SELECT name FROM services WHERE workspace_id = ${workspaceId} AND visibility <> 'only_me'
     ORDER BY created_at ASC LIMIT 1`).rows[0];
  const business = b.businessName || 'your business';
  const date = addDaysISO(todayInZone(cs?.timezone || 'UTC'), 14);
  const mail = renderRebookEmail({
    firstName: firstNameOf(ownerName), businessName: business, serviceName: svc?.name || 'appointment',
    usual: null, when: fmtSuggestionDay({ date, startMin: 600 }),
    url: cs?.slug ? `${appUrl()}/book/${encodeURIComponent(cs.slug)}` : appUrl(),
    branding: b,
    footer: 'This is a test of your book-again link. Each client sees the service they just had and a day and time picked from their own visits.',
  });
  await sendEmail({ to, subject: `[Test] ${mail.subject}`, html: mail.html });
  return { to, subject: mail.subject };
}

export function isUuid(v) { return UUID_RE.test(String(v || '')); }
