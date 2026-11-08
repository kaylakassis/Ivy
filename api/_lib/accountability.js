// The accountability partner: one shared list of "what needs the owner's
// attention" for a business, used by
//   • the dashboard's "Needs your attention" card (GET /api/dashboard),
//   • the partner's own settings + list endpoint (/api/me/accountability),
//   • Ivy's accountability_partner tool (read the list, change settings),
//   • the hourly partner cron (api/cron/accountability-partner.js), which
//     turns the list into at most one warm digest a day by push and email.
//
// Every query is scoped to one workspace_id. Sample data (clients.source =
// 'demo') never counts. Item text uses FIRST NAMES only, so a push on a
// lock screen never shows more than a first name; money amounts, document
// names and task titles live in `detail`, which is shown in the app and in
// the email body, never in a push.
//
// Item shape:
//   { key, kind, priority (1 = most important), count, title, phrase,
//     detail, href, action, inAppOnly?, ids }
// `phrase` is the lower-case form used inside the digest sentence
// ("reply to Jane"). `ids` feed the freshness fingerprint so the partner
// only speaks up again when something new happens (or enough time passed).
import crypto from 'node:crypto';
import { sql } from './db.js';
import { workspaceTimeZone } from './calendar.js';
import { computeSetupStatus } from './setupStatus.js';
import { listDuplicatePairs } from './clientDuplicates.js';
import { emailShell } from './email.js';
import { waitlistSummary } from './waitlist.js';
import { shopInvitesWaiting } from './shops.js';

// ── settings ────────────────────────────────────────────────────────────
// Kinds of reminders the owner can switch on and off (all on by default).
export const PARTNER_KINDS = ['messages', 'money', 'documents', 'clients', 'schedule', 'checkins'];
export const PARTNER_KIND_LABELS = {
  messages: 'Messages and new leads',
  money: 'Invoices, deposits and payments',
  documents: 'Documents to send or get signed',
  clients: 'Quiet clients, packages and reviews',
  schedule: "Today's schedule and tasks",
  checkins: "Check-ins when you've been away",
};
export const PARTNER_FREQUENCIES = ['daily', 'important', 'weekly'];
export const PARTNER_FREQUENCY_LABELS = {
  daily: 'Daily digest',
  important: 'Only important things',
  weekly: 'Weekly',
};

// Thresholds (also used by tests and the docs).
export const UNREAD_WAIT_HOURS = 4;
export const LEAD_WAIT_HOURS = 20;
export const QUIET_DAYS = 21;
export const DOC_UNSIGNED_DAYS = 3;
export const DOC_DRAFT_HOURS = 24;
export const INVOICE_DRAFT_DAYS = 2;
export const AWAY_FIRST_DAYS = 3;
export const AWAY_SECOND_DAYS = 7;
// The partner speaks between 9am and 7pm in the owner's time zone.
export const SEND_FROM_HOUR = 9;
export const SEND_UNTIL_HOUR = 19;
// How long before the same, unchanged item is worth mentioning again.
export const REPEAT_HOURS = { 1: 20, 2: 72, 3: 168 };

// Resolve the owner's partner settings from users.notification_prefs (the
// on/off switch and the email channel live there, next to the other
// notification switches) and users.accountability_prefs (frequency, kinds).
export function resolvePartnerSettings(notificationPrefs, accountabilityPrefs) {
  const np = notificationPrefs && typeof notificationPrefs === 'object' ? notificationPrefs : {};
  const ap = accountabilityPrefs && typeof accountabilityPrefs === 'object' ? accountabilityPrefs : {};
  const kinds = {};
  for (const k of PARTNER_KINDS) kinds[k] = !(ap.kinds && ap.kinds[k] === false);
  return {
    enabled: np.accountability !== false,
    emailEnabled: np.email_accountability !== false,
    frequency: PARTNER_FREQUENCIES.includes(ap.frequency) ? ap.frequency : 'daily',
    kinds,
  };
}

// Validate a settings patch. Returns { error } or { notificationPatch,
// prefsPatch } where each holds only the keys that were sent.
export function cleanSettingsPatch(body) {
  const b = body && typeof body === 'object' ? body : {};
  const notificationPatch = {};
  const prefsPatch = {};
  if ('enabled' in b) {
    if (typeof b.enabled !== 'boolean') return { error: 'enabled must be true or false' };
    notificationPatch.accountability = b.enabled;
  }
  if ('emailEnabled' in b) {
    if (typeof b.emailEnabled !== 'boolean') return { error: 'emailEnabled must be true or false' };
    notificationPatch.email_accountability = b.emailEnabled;
  }
  if ('frequency' in b) {
    if (!PARTNER_FREQUENCIES.includes(b.frequency)) return { error: `frequency must be one of ${PARTNER_FREQUENCIES.join(', ')}` };
    prefsPatch.frequency = b.frequency;
  }
  if ('kinds' in b) {
    if (!b.kinds || typeof b.kinds !== 'object' || Array.isArray(b.kinds)) return { error: 'kinds must be an object' };
    const kinds = {};
    for (const [k, v] of Object.entries(b.kinds)) {
      if (!PARTNER_KINDS.includes(k)) return { error: `Unknown kind: ${String(k).slice(0, 40)}` };
      if (typeof v !== 'boolean') return { error: `kinds.${k} must be true or false` };
      kinds[k] = v;
    }
    prefsPatch.kinds = kinds;
  }
  if (!Object.keys(notificationPatch).length && !Object.keys(prefsPatch).length) {
    return { error: 'Nothing to change' };
  }
  return { notificationPatch, prefsPatch };
}

export async function readPartnerSettings(userId) {
  const { rows } = await sql`SELECT notification_prefs, accountability_prefs FROM users WHERE id = ${userId}`;
  return resolvePartnerSettings(rows[0]?.notification_prefs, rows[0]?.accountability_prefs);
}

// `source` says where a turn off / on came from, for the admin view:
// 'settings' (Account > Notifications, which asks first with the warning),
// 'ivy' (Ivy's approval card, which carries the same warning) or 'other'.
export async function savePartnerSettings(userId, { notificationPatch = {}, prefsPatch = {} }, { source = 'other' } = {}) {
  const wasOn = 'accountability' in notificationPatch ? (await readPartnerSettings(userId)).enabled : null;
  if (Object.keys(notificationPatch).length) {
    await sql`
      UPDATE users SET notification_prefs = COALESCE(notification_prefs, '{}'::jsonb) || ${JSON.stringify(notificationPatch)}::jsonb
       WHERE id = ${userId}`;
  }
  if (Object.keys(prefsPatch).length) {
    // kinds merge key by key so a patch of one kind keeps the others.
    const { rows } = await sql`SELECT accountability_prefs FROM users WHERE id = ${userId}`;
    const cur = rows[0]?.accountability_prefs && typeof rows[0].accountability_prefs === 'object' ? rows[0].accountability_prefs : {};
    const next = { ...cur };
    if (prefsPatch.frequency) next.frequency = prefsPatch.frequency;
    if (prefsPatch.kinds) next.kinds = { ...(cur.kinds || {}), ...prefsPatch.kinds };
    await sql`UPDATE users SET accountability_prefs = ${JSON.stringify(next)}::jsonb WHERE id = ${userId}`;
  }
  const after = await readPartnerSettings(userId);
  if (wasOn !== null) await recordPartnerToggle(userId, wasOn, after.enabled, source);
  return after;
}

// ── tracking for the admin view (counts only) ───────────────────────────
// Best effort: tracking never blocks or fails what the owner asked for.
export async function recordPartnerEvent({ workspaceId, userId = null, event, kind = null, source = null, itemCount = null }) {
  try {
    const { rows } = await sql`
      INSERT INTO partner_events (workspace_id, user_id, event, kind, source, item_count)
      VALUES (${workspaceId}, ${userId}, ${event}, ${kind}, ${source}, ${itemCount})
      RETURNING id`;
    return rows[0]?.id || null;
  } catch (err) {
    console.warn('[accountability] event not recorded:', err.message);
    return null;
  }
}

// A turn off / on of the partner switch, from any route.
export async function recordPartnerToggle(userId, wasOn, isOn, source = 'other') {
  if (wasOn === isOn || !userId) return;
  try {
    const { rows } = await sql`SELECT id FROM workspaces WHERE owner_id = ${userId} ORDER BY created_at ASC LIMIT 1`;
    if (!rows[0]) return;
    await recordPartnerEvent({
      workspaceId: rows[0].id, userId, event: isOn ? 'turned_on' : 'turned_off',
      source: ['settings', 'ivy'].includes(source) ? source : 'other',
    });
  } catch { /* tracking only */ }
}

// The owner opened the app from a partner message's own link (?ptr=...).
// Only their own sends can be marked.
export async function markPartnerClicked(userId, ref) {
  if (!userId || !PARTNER_REF_RE.test(String(ref || ''))) return false;
  const [ch, id] = String(ref).split('.');
  const { rowCount } = await sql`
    UPDATE partner_events
       SET clicked_at = COALESCE(clicked_at, NOW()),
           click_channel = COALESCE(click_channel, ${ch === 'e' ? 'email' : 'notification'}),
           opened_at = COALESCE(opened_at, CASE WHEN NOW() <= created_at + INTERVAL '24 hours' THEN NOW() END)
     WHERE id = ${id} AND user_id = ${userId} AND event = 'sent'`;
  return rowCount > 0;
}

// ── was the thing a message named cleared? ──────────────────────────────
// A partner message names items (reply to Jane, send Maria's document...).
// Each is stored as a partner_mentions row with the ids of the things it
// named. While it is younger than MENTION_WINDOW_HOURS the cron re-runs
// just that item's detector every MENTION_RECHECK_MINUTES: once none of
// the named things are still waiting (or the item is gone from the list)
// it is cleared. Checks are periodic, so a clearance just before the 48
// hours can be seen just after and count as not cleared in time: the
// rate can only be too low, never too high.
export const MENTION_WINDOW_HOURS = 48;
export const MENTION_RECHECK_MINUTES = 110;
const realIds = (ids) => (Array.isArray(ids) ? ids : []).map(String)
  .filter((x) => !/^[nu]\d+$/.test(x)).map((x) => x.split(':')[0]);

export function mentionCleared(mentionIds, current) {
  if (!current) return true;
  const named = realIds(mentionIds);
  if (!named.length) return false; // a count-only item (quiet week): cleared only when it is gone
  const now = new Set(realIds(current.ids));
  return !named.some((id) => now.has(id));
}

export async function recordMentions(eventId, workspaceId, items) {
  for (const it of items || []) {
    if (!it || !DETECTORS[it.key]) continue;
    await sql`
      INSERT INTO partner_mentions (event_id, workspace_id, signal_key, item_ids)
      VALUES (${eventId}, ${workspaceId}, ${it.key}, ${JSON.stringify((it.ids || []).slice(0, 50).map(String))}::jsonb)`
      .catch(() => {});
  }
}

export async function checkPartnerMentions({ limit = 300, shardFilter = '', deadline = Infinity } = {}) {
  const out = { checked: 0, cleared: 0, settled: 0 };
  const { rows } = await sql.query(
    `SELECT m.id, m.workspace_id, m.signal_key, m.item_ids,
            (m.mentioned_at <= NOW() - INTERVAL '${MENTION_WINDOW_HOURS} hours') AS expired
       FROM partner_mentions m
      WHERE m.settled = FALSE
        AND (m.checked_at IS NULL OR m.checked_at <= NOW() - INTERVAL '${MENTION_RECHECK_MINUTES} minutes')
        ${shardFilter}
      ORDER BY m.checked_at ASC NULLS FIRST
      LIMIT $1`,
    [Math.max(1, Math.min(2000, limit))],
  );
  const cache = new Map();
  for (const m of rows) {
    if (Date.now() >= deadline) break;
    if (m.expired) {
      await sql`UPDATE partner_mentions SET settled = TRUE, checked_at = NOW() WHERE id = ${m.id}`;
      out.settled++;
      continue;
    }
    const k = `${m.workspace_id}|${m.signal_key}`;
    try {
      if (!cache.has(k)) {
        const tz = await workspaceTimeZone(m.workspace_id);
        // No safe(): a failed query must never read as "cleared".
        cache.set(k, await DETECTORS[m.signal_key](m.workspace_id, tz));
      }
    } catch {
      await sql`UPDATE partner_mentions SET checked_at = NOW() WHERE id = ${m.id}`;
      continue;
    }
    out.checked++;
    if (mentionCleared(m.item_ids, cache.get(k))) {
      await sql`UPDATE partner_mentions SET cleared_at = NOW(), settled = TRUE, checked_at = NOW() WHERE id = ${m.id}`;
      out.cleared++;
    } else {
      await sql`UPDATE partner_mentions SET checked_at = NOW() WHERE id = ${m.id}`;
    }
  }
  return out;
}

// ── text helpers ───────────────────────────────────────────────────────
// First name only, letters and the usual name punctuation, capped. Never
// an email address or a surname on a lock screen.
export function firstNameOf(name) {
  const raw = String(name || '').trim();
  if (!raw || raw.includes('@')) return '';
  const first = raw.split(/\s+/)[0].replace(/[^\p{L}\p{M}'’.-]/gu, '');
  return first.slice(0, 20);
}
function nameList(names, count) {
  const ns = names.map(firstNameOf).filter(Boolean);
  const unique = [...new Set(ns)];
  if (!unique.length) return count === 1 ? 'a client' : `${count} clients`;
  if (count <= 1) return unique[0];
  if (count === 2 && unique.length >= 2) return `${unique[0]} and ${unique[1]}`;
  const rest = count - 1;
  return `${unique[0]} and ${rest} ${rest === 1 ? 'other' : 'others'}`;
}
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const possessive = (n) => (/s$/i.test(n) ? `${n}'` : `${n}'s`);
function money(n, currency = 'USD') {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(Number(n || 0));
  } catch { return `$${Math.round(Number(n || 0))}`; }
}
function daysAgo(ts) {
  const d = Math.floor((Date.now() - new Date(ts).getTime()) / 86400000);
  if (d <= 0) return 'today';
  return d === 1 ? 'yesterday' : `${d} days ago`;
}
function hoursAgo(ts) {
  const h = Math.floor((Date.now() - new Date(ts).getTime()) / 3600000);
  if (h < 24) return `${Math.max(1, h)} ${h === 1 ? 'hour' : 'hours'}`;
  const d = Math.floor(h / 24);
  return `${d} ${d === 1 ? 'day' : 'days'}`;
}
const clip = (s, n = 60) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const lowerFirst = (s) => (s ? s[0].toLowerCase() + s.slice(1) : s);

// ── quiet clients (shared definition) ──────────────────────────────────
// An active client (not sample data) who has been with the business for at
// least QUIET_DAYS, with no message either way and no booking (past,
// upcoming or an ongoing repeating series) in the last QUIET_DAYS. Used by
// the partner, the dashboard, and Ivy's own snapshot (workspaceContext and
// buildBriefing in api/_lib/ivy.js), so every surface agrees. $1 is the
// workspace id; the caller adds ORDER BY / LIMIT.
export const QUIET_CLIENT_WHERE = `
  c.workspace_id = $1
  AND c.stage = 'active'
  AND c.source IS DISTINCT FROM 'demo'
  AND c.created_at < NOW() - INTERVAL '${QUIET_DAYS} days'
  AND NOT EXISTS (
    SELECT 1 FROM message_threads mt JOIN messages m ON m.thread_id = mt.id
     WHERE mt.workspace_id = c.workspace_id AND mt.client_id = c.id
       AND m.created_at >= NOW() - INTERVAL '${QUIET_DAYS} days')
  AND NOT EXISTS (
    SELECT 1 FROM bookings b
     WHERE b.workspace_id = c.workspace_id AND b.client_id = c.id AND b.cancelled_at IS NULL
       AND (b.date >= (NOW() - INTERVAL '${QUIET_DAYS} days')::date
            OR (b.recurrence_rule IS NOT NULL
                AND (b.recurrence_until IS NULL OR b.recurrence_until >= CURRENT_DATE))))`;

export async function quietClients(workspaceId, { limit = 5 } = {}) {
  const { rows } = await sql.query(
    `SELECT c.id, c.name, COUNT(*) OVER ()::int AS total
       FROM clients c
      WHERE ${QUIET_CLIENT_WHERE}
      ORDER BY c.created_at DESC
      LIMIT $2`,
    [workspaceId, Math.max(1, Math.min(50, limit))],
  );
  return { total: rows[0]?.total || 0, clients: rows.map((r) => ({ id: r.id, name: r.name })) };
}

// ── the signals ────────────────────────────────────────────────────────
const NOT_DEMO = `(c.source IS DISTINCT FROM 'demo')`;

// Each detector returns 0 or 1 item. Wrapped so one failing query never
// blanks the whole list.
async function safe(p) {
  try { return await p; } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[accountability] signal failed:', err.message);
    return null;
  }
}

async function unreadMessages(ws) {
  const { rows } = await sql.query(
    `SELECT t.id, t.last_message_at, c.name, COUNT(*) OVER ()::int AS total
       FROM message_threads t
       JOIN clients c ON c.id = t.client_id AND c.workspace_id = t.workspace_id
      WHERE t.workspace_id = $1 AND t.unread_biz > 0
        AND t.last_message_at IS NOT NULL
        AND t.last_message_at <= NOW() - ($2 || ' hours')::interval
        AND ${NOT_DEMO}
      ORDER BY t.last_message_at ASC
      LIMIT 5`,
    [ws, String(UNREAD_WAIT_HOURS)],
  );
  if (!rows.length) return null;
  const n = rows[0].total;
  const who = nameList(rows.map((r) => r.name), n);
  return {
    key: 'unread_messages', kind: 'messages', priority: 1, count: n,
    title: `Reply to ${who}`,
    phrase: `reply to ${who}`,
    detail: `Waiting ${hoursAgo(rows[0].last_message_at)}`,
    href: n === 1 ? `/messages?threadId=${rows[0].id}` : '/messages',
    action: 'Reply',
    ids: rows.map((r) => r.id),
  };
}

async function leadsWaiting(ws) {
  const { rows } = await sql.query(
    `SELECT c.id, c.name, COUNT(*) OVER ()::int AS total
       FROM clients c
      WHERE c.workspace_id = $1 AND c.stage = 'lead' AND ${NOT_DEMO}
        AND c.created_at < NOW() - ($2 || ' hours')::interval
        AND c.created_at > NOW() - INTERVAL '30 days'
        AND NOT EXISTS (
          SELECT 1 FROM message_threads mt JOIN messages m ON m.thread_id = mt.id
           WHERE mt.workspace_id = c.workspace_id AND mt.client_id = c.id AND m.sender = 'biz')
      ORDER BY c.created_at ASC
      LIMIT 5`,
    [ws, String(LEAD_WAIT_HOURS)],
  );
  if (!rows.length) return null;
  const n = rows[0].total;
  const who = nameList([rows[0].name], 1);
  const title = n === 1 ? `Follow up with ${who}, a new lead` : `Follow up with ${n} new leads`;
  return {
    key: 'leads_waiting', kind: 'messages', priority: 1, count: n,
    title, phrase: n === 1 ? `follow up with new lead ${who}` : lowerFirst(title), detail: 'A quick reply is what wins most new clients',
    href: '/clients?filter=leads', action: 'Follow up',
    ids: rows.map((r) => r.id),
  };
}

async function depositReviews(ws) {
  const { rows } = await sql`
    SELECT b.id, b.client_name, COUNT(*) OVER ()::int AS total
      FROM bookings b
     WHERE b.workspace_id = ${ws} AND b.deposit_refund_request_status = 'pending'
     ORDER BY b.deposit_refund_requested_at ASC
     LIMIT 5`;
  if (!rows.length) return null;
  const n = rows[0].total;
  const title = n === 1
    ? `Decide on ${possessive(nameList([rows[0].client_name], 1))} deposit refund`
    : `Decide on ${n} deposit refunds`;
  return {
    key: 'deposit_reviews', kind: 'money', priority: 1, count: n,
    title, phrase: lowerFirst(title), detail: 'Refund it or keep it, from your calendar',
    href: '/calendar', action: 'Review', ids: rows.map((r) => r.id),
  };
}

async function autopayFailed(ws) {
  const { rows } = await sql`
    SELECT i.id, i.client_name, COUNT(*) OVER ()::int AS total
      FROM invoices i
     WHERE i.workspace_id = ${ws} AND i.autopay_status = 'failed'
       AND i.status IN ('sent', 'overdue') AND i.archived_at IS NULL
     ORDER BY i.autopay_failed_at ASC NULLS LAST
     LIMIT 5`;
  if (!rows.length) return null;
  const n = rows[0].total;
  const first = nameList([rows[0].client_name], 1);
  return {
    key: 'autopay_failed', kind: 'money', priority: 1, count: n,
    title: n === 1 ? `${possessive(first)} automatic payment did not go through` : `${n} automatic payments did not go through`,
    phrase: n === 1 ? `check ${possessive(first)} automatic payment` : `check ${n} automatic payments`,
    detail: 'The card was declined, so the invoice is still open',
    href: n === 1 ? `/finance?invoice=${rows[0].id}` : '/finance?filter=sent',
    action: 'Open', ids: rows.map((r) => r.id),
  };
}

async function invoicesOverdue(ws) {
  const { rows } = await sql`
    SELECT COUNT(*)::int AS n,
           COALESCE(SUM(GREATEST(total
             - CASE WHEN paid_method = 'gift_card' THEN 0
                    ELSE GREATEST(gift_card_credit_cents - gift_card_credit_restored_cents, 0) / 100.0 END
             - GREATEST(COALESCE(paid_amount, 0) - COALESCE(refunded_amount, 0), 0), 0)), 0)::numeric AS owed,
           ARRAY_AGG(id ORDER BY id) AS ids
      FROM invoices
     WHERE workspace_id = ${ws} AND status = 'overdue' AND archived_at IS NULL`;
  const n = Number(rows[0]?.n || 0);
  if (!n) return null;
  const cur = (await sql`SELECT currency FROM finance_settings WHERE workspace_id = ${ws}`).rows[0]?.currency || 'USD';
  return {
    key: 'invoices_overdue', kind: 'money', priority: 1, count: n,
    title: n === 1 ? 'Chase an overdue invoice' : `Chase ${n} overdue invoices`,
    phrase: n === 1 ? 'chase an overdue invoice' : `chase ${n} overdue invoices`,
    detail: `${money(rows[0].owed, cur)} outstanding`,
    href: '/finance?filter=overdue', action: 'Chase', ids: (rows[0].ids || []).slice(0, 50),
  };
}

async function depositsUnpaidToday(ws, tz) {
  const { rows } = await sql`
    SELECT b.id, b.client_name, COUNT(*) OVER ()::int AS total
      FROM bookings b
      LEFT JOIN clients c ON c.id = b.client_id AND c.workspace_id = b.workspace_id
     WHERE b.workspace_id = ${ws} AND b.cancelled_at IS NULL
       AND (b.requested_at IS NULL OR b.request_decided_at IS NOT NULL)
       AND b.date = (NOW() AT TIME ZONE ${tz})::date
       AND COALESCE(b.deposit_required, 0) > 0 AND b.deposit_paid_at IS NULL
       AND (c.id IS NULL OR c.source IS DISTINCT FROM 'demo')
     ORDER BY b.start_min ASC
     LIMIT 5`;
  if (!rows.length) return null;
  const n = rows[0].total;
  const first = nameList([rows[0].client_name], 1);
  return {
    key: 'deposits_unpaid_today', kind: 'schedule', priority: 1, count: n,
    title: n === 1 ? `${possessive(first)} deposit for today is not paid yet` : `${n} deposits for today are not paid yet`,
    phrase: n === 1 ? `check ${possessive(first)} deposit for today` : `check ${n} unpaid deposits for today`,
    detail: 'Ask them to pay, or decide whether the booking still goes ahead',
    href: n === 1 ? `/calendar?booking=${rows[0].id}` : '/calendar', action: 'Open',
    ids: rows.map((r) => r.id),
  };
}

async function docsUnsent(ws) {
  const { rows } = await sql.query(
    `SELECT d.id, d.name AS doc_name, d.recipient_name, COUNT(*) OVER ()::int AS total
       FROM documents d
      WHERE d.workspace_id = $1 AND d.status = 'draft'
        AND COALESCE(d.is_template, FALSE) = FALSE
        AND (d.recipient_client_id IS NOT NULL OR d.recipient_email IS NOT NULL)
        AND d.created_at < NOW() - ($2 || ' hours')::interval
        AND d.created_at > NOW() - INTERVAL '60 days'
      ORDER BY d.created_at ASC
      LIMIT 5`,
    [ws, String(DOC_DRAFT_HOURS)],
  );
  if (!rows.length) return null;
  const n = rows[0].total;
  const first = nameList([rows[0].recipient_name], 1);
  const title = n === 1 ? `Send ${possessive(first)} document` : `Send ${n} documents you drafted`;
  return {
    key: 'docs_unsent', kind: 'documents', priority: 2, count: n,
    title, phrase: lowerFirst(title),
    detail: n === 1 ? `"${clip(rows[0].doc_name, 50)}" is drafted but not sent` : 'Drafted but not sent yet',
    href: n === 1 ? `/documents?doc=${rows[0].id}` : '/documents', action: 'Send',
    ids: rows.map((r) => r.id),
  };
}

async function docsUnsigned(ws) {
  const { rows } = await sql.query(
    `SELECT d.id, d.name AS doc_name, d.recipient_name, d.sent_at, COUNT(*) OVER ()::int AS total
       FROM documents d
      WHERE d.workspace_id = $1 AND d.status = 'sent' AND d.declined_at IS NULL
        AND COALESCE(d.is_template, FALSE) = FALSE
        AND d.sent_at < NOW() - ($2 || ' days')::interval
        AND d.sent_at > NOW() - INTERVAL '90 days'
      ORDER BY d.sent_at ASC
      LIMIT 5`,
    [ws, String(DOC_UNSIGNED_DAYS)],
  );
  if (!rows.length) return null;
  const n = rows[0].total;
  const first = nameList([rows[0].recipient_name], 1);
  const title = n === 1 ? `Remind ${first} to sign` : `${n} documents are waiting for a signature`;
  return {
    key: 'docs_unsigned', kind: 'documents', priority: 2, count: n,
    title, phrase: n === 1 ? `remind ${first} to sign` : `nudge ${n} unsigned documents`,
    detail: n === 1 ? `"${clip(rows[0].doc_name, 50)}", sent ${daysAgo(rows[0].sent_at)}` : `Oldest sent ${daysAgo(rows[0].sent_at)}`,
    href: n === 1 ? `/documents?doc=${rows[0].id}` : '/documents', action: 'Remind',
    ids: rows.map((r) => r.id),
  };
}

async function invoicesDraft(ws) {
  const { rows } = await sql.query(
    `SELECT i.id, i.client_name, COUNT(*) OVER ()::int AS total
       FROM invoices i
       LEFT JOIN clients c ON c.id = i.client_id AND c.workspace_id = i.workspace_id
      WHERE i.workspace_id = $1 AND i.status = 'draft' AND i.archived_at IS NULL
        AND i.recurring_invoice_id IS NULL
        AND (c.id IS NULL OR c.source IS DISTINCT FROM 'demo')
        AND i.created_at < NOW() - ($2 || ' days')::interval
        AND i.created_at > NOW() - INTERVAL '60 days'
      ORDER BY i.created_at ASC
      LIMIT 5`,
    [ws, String(INVOICE_DRAFT_DAYS)],
  );
  if (!rows.length) return null;
  const n = rows[0].total;
  const first = nameList([rows[0].client_name], 1);
  const title = n === 1 ? `Send ${possessive(first)} invoice` : `Send ${n} draft invoices`;
  return {
    key: 'invoices_draft', kind: 'money', priority: 2, count: n,
    title, phrase: lowerFirst(title), detail: 'Drafted but never sent, so nobody can pay it yet',
    href: n === 1 ? `/finance?invoice=${rows[0].id}` : '/finance?filter=draft', action: 'Send',
    ids: rows.map((r) => r.id),
  };
}

async function tasksDue(ws, tz) {
  const { rows } = await sql`
    SELECT id, title, due_date,
           (due_date < (NOW() AT TIME ZONE ${tz})::date) AS overdue,
           COUNT(*) OVER ()::int AS total
      FROM tasks
     WHERE workspace_id = ${ws} AND done = FALSE AND due_date IS NOT NULL
       AND due_date <= (NOW() AT TIME ZONE ${tz})::date
     ORDER BY due_date ASC
     LIMIT 5`;
  if (!rows.length) return null;
  const n = rows[0].total;
  const anyOverdue = rows.some((r) => r.overdue);
  const title = anyOverdue
    ? (n === 1 ? 'A task is overdue' : `${n} tasks are due or overdue`)
    : (n === 1 ? 'Finish a task due today' : `Finish ${n} tasks due today`);
  return {
    key: 'tasks_due', kind: 'schedule', priority: 2, count: n,
    title, phrase: anyOverdue ? (n === 1 ? 'finish an overdue task' : `finish ${n} tasks that are due`) : lowerFirst(title),
    detail: clip(rows[0].title, 70),
    href: '/dashboard#goals', action: 'Open', ids: rows.map((r) => r.id),
  };
}

async function setupGap(ws) {
  const { rows } = await sql`
    SELECT u.id, u.email_verified_at FROM workspaces w JOIN users u ON u.id = w.owner_id WHERE w.id = ${ws}`;
  if (!rows[0]) return null;
  const status = await computeSetupStatus({ userId: rows[0].id, workspaceId: ws, emailVerifiedAt: rows[0].email_verified_at });
  const next = (status?.items || []).find((i) => i.required && !i.done);
  if (!next) return null;
  return {
    key: 'setup', kind: 'schedule', priority: 1, count: 1,
    title: `Finish setup: ${lowerFirst(next.label)}`,
    phrase: `finish setup (${lowerFirst(next.label)})`,
    detail: next.why || 'Your booking page needs this before it can take bookings',
    href: next.href || '/dashboard', action: 'Finish',
    // The one-shot setup email (api/cron/setup-nudge.js) owns this nudge
    // outside the app, so the partner shows it in the app only.
    inAppOnly: true, ids: [next.id],
  };
}

async function quietClientsSignal(ws) {
  const { total, clients } = await quietClients(ws, { limit: 3 });
  if (!total) return null;
  const title = total <= 2
    ? `Check in with ${nameList(clients.map((c) => c.name), total)}`
    : `${total} clients have gone quiet`;
  return {
    key: 'quiet_clients', kind: 'clients', priority: 3, count: total,
    title, phrase: total <= 2 ? lowerFirst(title) : `check in with ${total} quiet clients`,
    detail: `No booking or message in ${QUIET_DAYS} days`,
    href: `/ivy?prompt=${encodeURIComponent("Help me reconnect with the clients who've gone quiet.")}`,
    action: 'Check in', ids: clients.map((c) => c.id).concat([`n${total}`]),
  };
}

async function packagesLow(ws) {
  const { rows } = await sql`
    SELECT cp.id, cp.client_id, c.name, cp.credits_remaining, COUNT(*) OVER ()::int AS total
      FROM client_packages cp
      JOIN clients c ON c.id = cp.client_id AND c.workspace_id = cp.workspace_id
     WHERE cp.workspace_id = ${ws} AND c.source IS DISTINCT FROM 'demo'
       AND (
         (cp.status = 'active' AND cp.credits_remaining = 1)
         OR (cp.status = 'exhausted' AND cp.updated_at > NOW() - INTERVAL '30 days')
       )
       -- They already have more sessions to use: nothing to do.
       AND NOT EXISTS (
         SELECT 1 FROM client_packages cp2
          WHERE cp2.workspace_id = cp.workspace_id AND cp2.client_id = cp.client_id
            AND cp2.id <> cp.id AND cp2.status = 'active' AND cp2.credits_remaining > 0)
       -- Already rebooked: nothing to do.
       AND NOT EXISTS (
         SELECT 1 FROM bookings b
          WHERE b.workspace_id = cp.workspace_id AND b.client_id = cp.client_id
            AND b.cancelled_at IS NULL AND b.date >= CURRENT_DATE)
     ORDER BY cp.updated_at DESC
     LIMIT 5`;
  if (!rows.length) return null;
  const n = rows[0].total;
  const first = nameList([rows[0].name], 1);
  const usedUp = Number(rows[0].credits_remaining) === 0;
  const title = n === 1
    ? (usedUp ? `${first} used up their package` : `${first} has 1 package session left`)
    : `${n} clients are almost out of package sessions`;
  return {
    key: 'packages_low', kind: 'clients', priority: 3, count: n,
    title, phrase: n === 1 ? `offer ${first} a new package` : `offer ${n} clients a new package`,
    detail: 'No next session booked yet',
    href: n === 1 ? `/clients?id=${rows[0].client_id}` : '/clients', action: 'Open',
    ids: rows.map((r) => `${r.id}:${r.credits_remaining}`),
  };
}

async function reviewsToReply(ws) {
  const { rows } = await sql`
    SELECT id, reviewer_name, COUNT(*) OVER ()::int AS total
      FROM reviews
     WHERE workspace_id = ${ws} AND status = 'visible'
       AND owner_response IS NULL AND created_at > NOW() - INTERVAL '30 days'
     ORDER BY created_at DESC
     LIMIT 5`;
  if (!rows.length) return null;
  const n = rows[0].total;
  const first = nameList([rows[0].reviewer_name], 1);
  const title = n === 1 ? `Reply to ${possessive(first)} review` : `Reply to ${n} new reviews`;
  return {
    key: 'reviews_reply', kind: 'clients', priority: 3, count: n,
    title, phrase: lowerFirst(title), detail: 'A short thank-you shows on your page',
    href: '/reviews', action: 'Reply', ids: rows.map((r) => r.id),
  };
}

async function duplicates(ws) {
  const { total } = await listDuplicatePairs(ws, { limit: 0, withCounts: false });
  if (!total) return null;
  return {
    key: 'duplicates', kind: 'clients', priority: 3, count: total,
    title: `Tidy up ${plural(total, 'possible duplicate client', 'possible duplicate clients')}`,
    phrase: `tidy up ${plural(total, 'possible duplicate', 'possible duplicates')}`,
    detail: 'Merge the same person saved twice', href: '/clients?duplicates=1', action: 'Review',
    inAppOnly: true, ids: [`n${total}`],
  };
}

async function quietWeek(ws, tz) {
  const { rows } = await sql`
    SELECT
      (SELECT COUNT(*)::int FROM bookings b
        WHERE b.workspace_id = ${ws} AND b.cancelled_at IS NULL
          AND b.date >= (NOW() AT TIME ZONE ${tz})::date
          AND b.date <  (NOW() AT TIME ZONE ${tz})::date + 7) AS upcoming,
      (SELECT COUNT(*)::int FROM clients
        WHERE workspace_id = ${ws} AND stage = 'active' AND source IS DISTINCT FROM 'demo') AS active`;
  const r = rows[0] || {};
  if (!(Number(r.active) >= 3 && Number(r.upcoming) <= 2)) return null;
  return {
    key: 'quiet_week', kind: 'schedule', priority: 3, count: Number(r.upcoming),
    title: 'Your next 7 days are quiet',
    phrase: 'fill a few open spots this week',
    detail: `${plural(Number(r.upcoming), 'session', 'sessions')} booked so far`,
    href: `/ivy?prompt=${encodeURIComponent("Draft a campaign to fill next week's open slots, targeting my quiet clients.")}`,
    action: 'Fill it', ids: [`u${r.upcoming}`],
  };
}

// Clients with an appointment in the next 7 days and no email on file get
// no reminder (the dashboard used to show this as its own card).
async function missingEmail(ws, tz) {
  const { rows } = await sql`
    SELECT c.id, c.name, COUNT(*) OVER ()::int AS total
      FROM clients c
     WHERE c.workspace_id = ${ws} AND (c.email IS NULL OR c.email = '')
       AND c.source IS DISTINCT FROM 'demo'
       AND EXISTS (
         SELECT 1 FROM bookings b
          WHERE b.workspace_id = c.workspace_id AND b.client_id = c.id AND b.cancelled_at IS NULL
            AND b.date >= (NOW() AT TIME ZONE ${tz})::date
            AND b.date <  (NOW() AT TIME ZONE ${tz})::date + 7)
     ORDER BY c.name
     LIMIT 5`;
  if (!rows.length) return null;
  const n = rows[0].total;
  const first = nameList([rows[0].name], 1);
  const title = n === 1 ? `Add ${possessive(first)} email before their appointment` : `Add emails for ${n} clients booked this week`;
  return {
    key: 'missing_email', kind: 'schedule', priority: 2, count: n,
    title, phrase: lowerFirst(title), detail: 'Without an email, no reminder goes out',
    href: '/clients?filter=missing-email', action: 'Add', ids: rows.map((r) => r.id),
  };
}

// 1.0.6: booking requests waiting for Approve / Decline. The dashboard card
// shows Approve and Decline right on the row (`requests`, kept by
// publicItem); the partner's message links to the calendar.
async function bookingRequests(ws, tz) {
  const { rows } = await sql`
    SELECT b.id, b.client_name, b.date, b.start_min, b.request_expires_at, s.name AS service_name,
           COUNT(*) OVER ()::int AS total
      FROM bookings b
      LEFT JOIN services s ON s.id = b.service_id AND s.workspace_id = b.workspace_id
      LEFT JOIN clients c ON c.id = b.client_id AND c.workspace_id = b.workspace_id
     WHERE b.workspace_id = ${ws}
       AND b.requested_at IS NOT NULL AND b.request_decided_at IS NULL AND b.cancelled_at IS NULL
       AND (c.id IS NULL OR c.source IS DISTINCT FROM 'demo')
     ORDER BY b.request_expires_at ASC
     LIMIT 5`;
  if (!rows.length) return null;
  const n = rows[0].total;
  const first = nameList([rows[0].client_name], 1);
  const dayOf = (d) => new Date(`${String(d instanceof Date ? d.toISOString().slice(0, 10) : d).slice(0, 10)}T00:00:00Z`)
    .toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  const timeOf = (m) => `${((Math.floor(m / 60) + 11) % 12) + 1}:${String(m % 60).padStart(2, '0')} ${m >= 720 ? 'pm' : 'am'}`;
  const holdOf = (ts) => {
    try { return new Intl.DateTimeFormat('en-US', { timeZone: tz || 'UTC', weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(ts)); }
    catch { return ''; }
  };
  const title = n === 1 ? `Booking request from ${first}` : `${n} booking requests to answer`;
  return {
    key: 'booking_requests', kind: 'schedule', priority: 1, count: n,
    title, phrase: n === 1 ? `answer ${possessive(first)} booking request` : `answer ${n} booking requests`,
    detail: n === 1
      ? `${rows[0].service_name || 'Session'}, ${dayOf(rows[0].date)} at ${timeOf(rows[0].start_min)}. Held until ${holdOf(rows[0].request_expires_at)}`
      : 'Each one holds its time until you answer',
    href: n === 1 ? `/calendar?request=${rows[0].id}` : '/calendar?requests=1', action: 'Review',
    ids: rows.map((r) => r.id),
    requests: rows.map((r) => ({
      id: r.id, firstName: nameList([r.client_name], 1), service: r.service_name || 'Session',
      when: `${dayOf(r.date)} at ${timeOf(r.start_min)}`, holdsUntil: holdOf(r.request_expires_at),
    })),
  };
}

// 1.0.6: people on the waitlist. Informational (nothing to send): the owner
// can offer them a time from Calendar > Waitlist.
async function waitlistWaiting(ws) {
  const rows = await waitlistSummary(ws);
  if (!rows.length) return null;
  const total = rows.reduce((n, r) => n + Number(r.waiting || 0), 0);
  if (!total) return null;
  const top = rows[0];
  const title = rows.length === 1
    ? `${plural(top.waiting, 'person', 'people')} waiting for ${top.serviceName}`
    : `${plural(total, 'person', 'people')} waiting for a spot`;
  return {
    key: 'waitlist_waiting', kind: 'schedule', priority: 3, count: total,
    title, phrase: lowerFirst(title),
    detail: rows.length === 1 ? 'Offer them a time when one opens up' : rows.map((r) => `${r.waiting} for ${r.serviceName}`).join(', '),
    href: '/calendar?waitlist=1', action: 'See', inAppOnly: true,
    ids: rows.map((r) => `${r.serviceId}:${r.waiting}`),
  };
}

// Display order inside a priority band.
const ORDER = [
  'setup', 'booking_requests', 'unread_messages', 'leads_waiting', 'deposits_unpaid_today', 'autopay_failed', 'deposit_reviews',
  'invoices_overdue', 'docs_unsent', 'docs_unsigned', 'invoices_draft', 'missing_email', 'tasks_due',
  'quiet_clients', 'packages_low', 'reviews_reply', 'quiet_week', 'duplicates', 'waitlist_waiting', 'shop_invites',
];

// A shop page invited this business and nobody has answered yet (1.0.6).
async function shopInvitesSignal(ws) {
  const owner = await sql`SELECT u.email FROM workspaces w JOIN users u ON u.id = w.owner_id WHERE w.id = ${ws}`;
  const rows = await shopInvitesWaiting(ws, owner.rows[0]?.email || null);
  if (!rows.length) return null;
  const title = rows.length === 1 ? `${rows[0].name} invited you to their shop page` : `${rows.length} shop pages invited you`;
  return {
    key: 'shop_invites', kind: 'schedule', priority: 2, count: rows.length,
    title, phrase: lowerFirst(title), detail: 'Accept to be listed next to the other pros, or decline',
    href: '/shops', action: 'Answer', ids: rows.map((r) => r.id),
  };
}

// Every detector by the key of the item it produces. computeSignals runs
// them all; the admin view's "was it cleared?" check (checkPartnerMentions)
// re-runs just the one a partner message named.
const DETECTORS = {
  booking_requests: (ws, tz) => bookingRequests(ws, tz),
  waitlist_waiting: (ws) => waitlistWaiting(ws),
  unread_messages: (ws) => unreadMessages(ws),
  leads_waiting: (ws) => leadsWaiting(ws),
  deposit_reviews: (ws) => depositReviews(ws),
  autopay_failed: (ws) => autopayFailed(ws),
  invoices_overdue: (ws) => invoicesOverdue(ws),
  deposits_unpaid_today: (ws, tz) => depositsUnpaidToday(ws, tz),
  docs_unsent: (ws) => docsUnsent(ws),
  docs_unsigned: (ws) => docsUnsigned(ws),
  invoices_draft: (ws) => invoicesDraft(ws),
  tasks_due: (ws, tz) => tasksDue(ws, tz),
  setup: (ws) => setupGap(ws),
  quiet_clients: (ws) => quietClientsSignal(ws),
  packages_low: (ws) => packagesLow(ws),
  reviews_reply: (ws) => reviewsToReply(ws),
  duplicates: (ws) => duplicates(ws),
  quiet_week: (ws, tz) => quietWeek(ws, tz),
  missing_email: (ws, tz) => missingEmail(ws, tz),
  shop_invites: (ws) => shopInvitesSignal(ws),
};
export const SIGNAL_KEYS = Object.keys(DETECTORS);

// Everything that needs the owner's attention right now, most important
// first. `tz` may be passed by a caller that already has it.
export async function computeSignals(workspaceId, { tz: tzIn } = {}) {
  if (!workspaceId) return [];
  const tz = tzIn || await workspaceTimeZone(workspaceId);
  const found = await Promise.all(Object.values(DETECTORS).map((fn) => safe(fn(workspaceId, tz))));
  return found.filter(Boolean)
    .map((it) => ({ ...it, fingerprint: fingerprintOf(it) }))
    .sort((a, b) => (a.priority - b.priority) || (ORDER.indexOf(a.key) - ORDER.indexOf(b.key)));
}

// The public shape (no internal ids) for the app and Ivy.
export function publicItem(it) {
  return {
    key: it.key, kind: it.kind, priority: it.priority, count: it.count,
    title: it.title, detail: it.detail || null, href: it.href, action: it.action,
    important: it.priority === 1,
    // 1.0.6: booking requests carry the rows for the card's inline Approve /
    // Decline buttons (first names only, like every title).
    ...(Array.isArray(it.requests) ? { requests: it.requests } : {}),
  };
}

export function fingerprintOf(it) {
  const ids = (it.ids || []).map(String).sort().join(',');
  return crypto.createHash('sha1').update(`${it.key}|${ids}`).digest('hex').slice(0, 16);
}

// ── choosing what goes in a message ─────────────────────────────────────
// Items the owner wants messages about: their kinds, their frequency
// ('important' keeps priority 1 only), never in-app-only items.
export function messageableItems(items, settings) {
  return (items || []).filter((it) => !it.inAppOnly
    && settings.kinds[it.kind] !== false
    && (settings.frequency !== 'important' || it.priority === 1));
}

// Is this item worth mentioning now? New (or changed) since the last time
// the partner mentioned it, or the same thing still open after its
// priority's repeat window.
export function isFresh(it, mentioned, now = Date.now()) {
  const prev = mentioned && mentioned[it.key];
  if (!prev || !prev.at) return true;
  if (prev.fp !== it.fingerprint) return true;
  const hours = REPEAT_HOURS[it.priority] || 168;
  return now - new Date(prev.at).getTime() >= hours * 3600000;
}

// ── the message text ───────────────────────────────────────────────────
export const PARTNER_TITLE = 'Ivy, your accountability partner';
const COUNT_WORDS = ['No things', 'One thing', 'Two things', 'Three things'];
function joinPhrases(ps) {
  if (ps.length <= 1) return ps[0] || '';
  return `${ps.slice(0, -1).join(', ')} and ${ps[ps.length - 1]}`;
}

// kind: 'digest' | 'away1' | 'away2'. items: already filtered + sorted.
// Returns { title, body, url, subject, heading, intro, outro } — plain text;
// the email renderer escapes it.
export function composeMessage({ kind = 'digest', items = [] }) {
  const top = items.slice(0, 3);
  const phrases = top.map((i) => i.phrase);
  const n = items.length;
  const countWord = COUNT_WORDS[Math.min(n, 3)];
  const single = n === 1 ? items[0].href : null;
  if (kind === 'away1') {
    return {
      title: PARTNER_TITLE,
      body: n
        ? `It's been a few days, so here's a quick catch-up: ${joinPhrases(phrases)}. A few minutes today keeps you on top of things.`
        : "It's been a few days. Nothing urgent is waiting, and a quick look keeps everything on track.",
      url: single || '/dashboard',
      subject: n ? 'A quick catch-up from Ivy' : 'Checking in from Ivy',
      heading: "It's been a few days",
      intro: n
        ? "Here's what came in while you were away. Each one takes a minute or two."
        : 'Nothing urgent is waiting. A quick look keeps everything on track.',
      outro: "You've got this.",
    };
  }
  if (kind === 'away2') {
    return {
      title: PARTNER_TITLE,
      body: n
        ? `Just checking in. Whenever you're ready, ${n === 1 ? 'one thing is' : `${n} things are`} waiting, starting with: ${phrases[0]}. No rush, Ivy is keeping track.`
        : "Just checking in. Your clients and calendar are right where you left them, whenever you're ready.",
      url: single || '/dashboard',
      subject: 'Just checking in',
      heading: 'Just checking in',
      intro: n
        ? "No rush. Whenever you're ready, here's what's waiting. Ivy is keeping track in the meantime."
        : "Your clients and calendar are right where you left them, whenever you're ready.",
      outro: "This is the last check-in until you're back. Ivy will pick up where you left off.",
    };
  }
  const head = n <= 3 ? `${countWord} worth 5 minutes today` : 'A few things worth 5 minutes today';
  if (n === 0) {
    // Never sent (the cron only writes when something needs the owner);
    // kept sensible for previews.
    return {
      title: PARTNER_TITLE, body: "You're all caught up today. Nice work.", url: '/dashboard',
      subject: "You're all caught up", heading: "You're all caught up", intro: 'Nothing needs you right now.', outro: 'Enjoy it.',
    };
  }
  return {
    title: PARTNER_TITLE,
    body: `${head}: ${joinPhrases(phrases)}${n > 3 ? `, plus ${n - 3} more in Ivy` : ''}.`,
    url: single || '/dashboard',
    subject: head,
    heading: head,
    intro: "Here's what would help most today. Each one takes a minute or two.",
    outro: "You're doing great. Small steps keep everything on track.",
  };
}

// The email body (HTML) for a message. Everything from the database is
// escaped; links are app-relative paths joined to the app URL.
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// Tags an app link with the partner message it came from (?ptr=<channel>.<id>)
// so the admin view can count "opened from the message". Only app-relative
// paths are tagged; anything else is returned unchanged.
export const PARTNER_REF_RE = /^[ne]\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function withPartnerRef(href, ref) {
  const h = String(href || '');
  if (!ref || !PARTNER_REF_RE.test(ref) || !h.startsWith('/')) return h;
  const hashAt = h.indexOf('#');
  const path = hashAt >= 0 ? h.slice(0, hashAt) : h;
  const hash = hashAt >= 0 ? h.slice(hashAt) : '';
  return `${path}${path.includes('?') ? '&' : '?'}ptr=${ref}${hash}`;
}

export function renderEmailBody({ msg, items = [], firstName = '', baseUrl = '', ref = null }) {
  const hi = firstName ? `Hi ${escapeHtml(firstName)},` : 'Hi,';
  const list = items.slice(0, 6).map((it) => {
    const url = `${baseUrl}${withPartnerRef(it.href && it.href.startsWith('/') ? it.href : '/dashboard', ref)}`;
    return `<li style="margin:0 0 10px;">
      <a href="${escapeHtml(url)}" style="font-weight:600;color:#5CC98E;">${escapeHtml(it.title)}</a>
      ${it.detail ? `<br><span style="font-size:13px;opacity:.8;">${escapeHtml(it.detail)}</span>` : ''}
    </li>`;
  }).join('');
  return `<p>${hi}</p>
    <p>${escapeHtml(msg.intro)}</p>
    ${list ? `<ul style="padding-left:18px;margin:14px 0;">${list}</ul>` : ''}
    ${items.length > 6 ? `<p>Plus ${items.length - 6} more on your dashboard.</p>` : ''}
    <p>${escapeHtml(msg.outro)}</p>
    <p>${escapeHtml(PARTNER_TITLE)}</p>`;
}
export const PARTNER_EMAIL_FOOTER = 'You get this because your accountability partner is on. To change how often it writes, or turn it off, go to Account > Notifications.';

// The full email: { subject, html, text }. Shared by the cron and the
// admin email preview, so the preview is the real thing.
// `ref` (optional, 'e.<event id>') tags the email's links for the admin
// view's "opened from the message" count.
export function renderPartnerEmail({ kind = 'digest', items = [], firstName = '', baseUrl = '', ref = null }) {
  const msg = composeMessage({ kind, items });
  const html = emailShell({
    heading: msg.heading,
    preheader: msg.subject,
    body: renderEmailBody({ msg, items, firstName, baseUrl, ref }),
    ctaText: 'Open Ivy',
    ctaUrl: `${baseUrl}${withPartnerRef('/dashboard', ref)}`,
    footer: PARTNER_EMAIL_FOOTER,
  });
  const lines = items.slice(0, 6).map((it) => `- ${it.title}${it.detail ? ` (${it.detail})` : ''}: ${baseUrl}${withPartnerRef(it.href, ref)}`);
  const text = [firstName ? `Hi ${firstName},` : 'Hi,', '', msg.intro, '', ...lines, '', msg.outro, PARTNER_TITLE, '', PARTNER_EMAIL_FOOTER].join('\n');
  return { subject: msg.subject, html, text, msg };
}

// Sample items for the admin email preview (clearly sample names).
export const SAMPLE_PARTNER_ITEMS = [
  { key: 'unread_messages', priority: 1, title: 'Reply to Jane', phrase: 'reply to Jane', detail: 'Waiting 1 day', href: '/messages' },
  { key: 'docs_unsent', priority: 2, title: "Send Maria's document", phrase: "send Maria's document", detail: '"Waiver" is drafted but not sent', href: '/documents' },
  { key: 'quiet_clients', priority: 3, title: '4 clients have gone quiet', phrase: 'check in with 4 quiet clients', detail: 'No booking or message in 21 days', href: '/clients' },
];

// ── owner-local day + snooze ───────────────────────────────────────────
export async function localToday(tz) {
  return (await sql`SELECT (NOW() AT TIME ZONE ${tz || 'UTC'})::date::text AS d`).rows[0].d;
}
export async function snoozeToday(workspaceId, on) {
  const tz = await workspaceTimeZone(workspaceId);
  const day = on ? await localToday(tz) : null;
  const { rows } = await sql`
    UPDATE workspaces SET partner_snoozed_day = ${day}::date WHERE id = ${workspaceId} RETURNING owner_id`;
  if (on && rows[0]) await recordPartnerEvent({ workspaceId, userId: rows[0].owner_id, event: 'snoozed' });
  return !!on;
}
export async function isSnoozedToday(workspaceId, tz) {
  const { rows } = await sql`
    SELECT (partner_snoozed_day IS NOT NULL
            AND partner_snoozed_day = (NOW() AT TIME ZONE ${tz || 'UTC'})::date) AS s
      FROM workspaces WHERE id = ${workspaceId}`;
  return !!rows[0]?.s;
}

// Everything the settings screen, the dashboard and Ivy need in one call.
export async function partnerOverview({ userId, workspaceId }) {
  const tz = await workspaceTimeZone(workspaceId);
  const [settings, items, snoozed, last] = await Promise.all([
    readPartnerSettings(userId),
    computeSignals(workspaceId, { tz }),
    isSnoozedToday(workspaceId, tz),
    sql`SELECT partner_last_sent_at FROM workspaces WHERE id = ${workspaceId}`,
  ]);
  return {
    ...settings,
    snoozedToday: snoozed,
    lastSentAt: last.rows[0]?.partner_last_sent_at || null,
    items: items.map(publicItem),
    total: items.length,
  };
}
