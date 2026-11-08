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
// Both are OFF by default. The owner's template (plain text with
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
import { mintRebookLink, lastServiceFor } from './rebook.js';

export const KINDS = ['birthday', 'quiet'];
export const KIND_LABELS = { birthday: 'Birthday message', quiet: "We'd love to see you again" };
export const ONCE_WORDS = { birthday: 'per year', quiet: 'every 90 days' };
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
  const safe = escapeHtml(text).split(marker).join(vars.booking_link
    ? `<a href="${escapeHtml(vars.booking_link)}" style="color:#4E63C7;font-weight:600;">${escapeHtml(vars.booking_link)}</a>` : '');
  return `<p>${safe.replace(/\n\n+/g, '</p><p>').replace(/\n/g, '<br/>')}</p>`;
}

// ── settings ───────────────────────────────────────────────────────────
function serialize(kind, row, extra = {}) {
  return {
    kind,
    label: KIND_LABELS[kind],
    enabled: !!row?.enabled,
    template: row?.template ?? DEFAULT_TEMPLATES[kind],
    defaultTemplate: DEFAULT_TEMPLATES[kind],
    channels: { email: row?.channels?.email !== false, sms: !!row?.channels?.sms },
    quietDays: kind === 'quiet' ? Number(row?.quiet_days || DEFAULT_QUIET_DAYS) : null,
    templateApprovedAt: row?.template_approved_at || null,
    once: ONCE_WORDS[kind],
    note: `Ivy sends this for you. Each client gets it at most once ${ONCE_WORDS[kind]}.`,
    sentThisMonth: Number(extra.sentThisMonth || 0),
    lastSentAt: extra.lastSentAt || null,
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
  if (!KINDS.includes(kind)) throw new Error('kind must be birthday or quiet');
  const p = patch && typeof patch === 'object' ? patch : {};
  const out = {};
  if ('enabled' in p) {
    if (typeof p.enabled !== 'boolean') throw new Error('enabled must be true or false');
    out.enabled = p.enabled;
  }
  if ('template' in p) {
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
  if (!Object.keys(out).length) throw new Error('Nothing to change');
  return out;
}

export async function saveAutomation(workspaceId, kind, patch) {
  const clean = cleanAutomationPatch(kind, patch);
  const cur = (await sql`SELECT * FROM client_automations WHERE workspace_id = ${workspaceId} AND kind = ${kind}`).rows[0] || null;
  const approved = clean.template != null || !!cur?.template_approved_at;
  if (clean.enabled === true && !approved) throw new Error('Save the message first, then turn it on');
  const channels = clean.channels || (cur?.channels ?? { email: true, sms: false });
  const row = (await sql`
    INSERT INTO client_automations (workspace_id, kind, enabled, template, channels, quiet_days, template_approved_at)
    VALUES (${workspaceId}, ${kind}, ${clean.enabled ?? cur?.enabled ?? false},
            ${clean.template ?? cur?.template ?? null},
            ${JSON.stringify(channels)}::jsonb,
            ${clean.quietDays ?? cur?.quiet_days ?? DEFAULT_QUIET_DAYS},
            ${clean.template != null ? new Date().toISOString() : (cur?.template_approved_at || null)})
    ON CONFLICT (workspace_id, kind) DO UPDATE SET
      enabled = EXCLUDED.enabled, template = EXCLUDED.template, channels = EXCLUDED.channels,
      quiet_days = EXCLUDED.quiet_days, template_approved_at = EXCLUDED.template_approved_at, updated_at = NOW()
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
  cs.slug, cs.biz_name, a.kind, a.template, a.channels, a.quiet_days,
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
  return {
    birthday: { enabled: cfg.birthday.enabled, clients: b.rows.map((r) => ({ clientId: r.id, name: r.name, day: r.day })) },
    quiet: { enabled: cfg.quiet.enabled, quietDays: cfg.quiet.quietDays, count: q.length, clients: q.map((r) => ({ clientId: r.client_id, name: r.name })) },
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
      const withCta = kind === 'quiet' || template.includes('{booking_link}');
      const r = await sendEmailToClient({
        clientId: client.client_id, workspaceId: ws.workspace_id, type: 'marketing', to: client.email,
        subject: EMAIL_SUBJECTS[kind](vars),
        replyTo: b.replyTo,
        html: emailShell({
          heading: EMAIL_SUBJECTS[kind](vars),
          body: templateHtml(template, vars),
          ctaText: withCta && vars.booking_link ? 'Book a time' : null,
          ctaUrl: withCta && vars.booking_link ? vars.booking_link : null,
          footer: `Sent by ${escapeHtml(business)}.`,
          branding: b,
        }),
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

// The cron's loop: every enabled automation in the sending window, each due
// client claimed then delivered. Stops at `deadline`.
export async function runClientAutomations({ shardFilter = '', deadline = Infinity, perWorkspaceCap = 200, workspaceId = null, inWindow = true } = {}) {
  const counts = { workspaces: 0, considered: 0, sent: 0, emailed: 0, texted: 0, skipped: 0, retried: 0, failed: 0 };
  for (const kind of KINDS) {
    const wss = await enabledWorkspaces(kind, { shardFilter, workspaceId, inWindow });
    for (const ws of wss) {
      if (Date.now() >= deadline) return { ...counts, terminatedBy: 'deadline' };
      counts.workspaces++;
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
  if (!KINDS.includes(kind)) throw new Error('kind must be birthday or quiet');
  if (!to) throw new Error('Your account has no email address');
  const tpl = template != null ? template : ((await sql`SELECT template FROM client_automations WHERE workspace_id = ${workspaceId} AND kind = ${kind}`).rows[0]?.template || DEFAULT_TEMPLATES[kind]);
  const problem = templateProblems(tpl);
  if (problem) throw new Error(problem);
  const b = await fetchBranding(workspaceId).catch(() => ({}));
  const cs = (await sql`SELECT slug FROM calendar_settings WHERE workspace_id = ${workspaceId}`).rows[0];
  const business = b.businessName || 'your business';
  const vars = { first_name: firstNameOf(ownerName), business, booking_link: cs?.slug ? `${appUrl()}/book/${encodeURIComponent(cs.slug)}` : '' };
  const subject = EMAIL_SUBJECTS[kind](vars);
  const withCta = kind === 'quiet' || tpl.includes('{booking_link}');
  await sendEmail({
    to, subject: `[Test] ${subject}`,
    html: emailShell({
      heading: subject, body: templateHtml(tpl, vars),
      ctaText: withCta && vars.booking_link ? 'Book a time' : null, ctaUrl: withCta && vars.booking_link ? vars.booking_link : null,
      footer: 'This is a test of your automated message. Clients see their own first name and, when they have one, a link to book their usual service again.',
      branding: b,
    }),
  });
  return { to, subject };
}

export function isUuid(v) { return UUID_RE.test(String(v || '')); }
