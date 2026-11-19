// "Does this client need me?" for the Clients list.
//
// One answer per client, in plain words, worked out over the whole book
// (never just the page that happens to be loaded), so the row label, the
// "Needs attention" filter and its count always agree. The rules are the
// same ones Home's "Needs your attention" card uses (api/_lib/
// accountability.js): overdue money, an unread message, a new lead nobody
// has replied to, a package that is used up, and a client who has gone
// quiet. Home waits a few hours before nagging about a message or a lead;
// the list shows them straight away, because here it is a fact about the
// client, not a reminder.
//
// A client with several reasons shows the most pressing one (the order of
// REASONS below) and counts how many more there are.
import { sql } from './db.js';
import { getOrSet } from './hotCache.js';
import { QUIET_CLIENT_WHERE, QUIET_DAYS } from './accountability.js';

export const ATTENTION_REASONS = ['overdue', 'message', 'lead', 'package', 'quiet'];
const TTL_MS = 20 * 1000;       // one screen load asks three times (list, summary, next page)
const MAX_PER_SIGNAL = 5000;

const money = (n, currency = 'USD') => {
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(Number(n) || 0); }
  catch { return `$${(Number(n) || 0).toFixed(2)}`; }
};
const daysSince = (d) => Math.max(0, Math.floor((Date.now() - new Date(d).getTime()) / 86400e3));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Each loader returns rows of { client_id, ... } for clients it applies to.
async function overdue(ws) {
  const { rows } = await sql`
    SELECT i.client_id,
           COUNT(*)::int AS n,
           MIN(i.due_date) AS oldest_due,
           COALESCE(SUM(GREATEST(i.total
             - CASE WHEN i.paid_method = 'gift_card' THEN 0
                    ELSE GREATEST(i.gift_card_credit_cents - i.gift_card_credit_restored_cents, 0) / 100.0 END
             - GREATEST(COALESCE(i.paid_amount, 0) - COALESCE(i.refunded_amount, 0), 0), 0)), 0)::numeric AS owed
      FROM invoices i
      JOIN clients c ON c.id = i.client_id AND c.workspace_id = i.workspace_id
     WHERE i.workspace_id = ${ws} AND i.status = 'overdue' AND i.archived_at IS NULL
       AND c.source IS DISTINCT FROM 'demo'
     GROUP BY i.client_id
     LIMIT ${MAX_PER_SIGNAL}`;
  return rows;
}
async function unread(ws) {
  const { rows } = await sql`
    SELECT t.client_id, MIN(t.last_message_at) AS since
      FROM message_threads t
      JOIN clients c ON c.id = t.client_id AND c.workspace_id = t.workspace_id
     WHERE t.workspace_id = ${ws} AND t.unread_biz > 0 AND t.last_message_at IS NOT NULL
       AND c.source IS DISTINCT FROM 'demo'
     GROUP BY t.client_id
     LIMIT ${MAX_PER_SIGNAL}`;
  return rows;
}
async function leads(ws) {
  const { rows } = await sql`
    SELECT c.id AS client_id, c.created_at
      FROM clients c
     WHERE c.workspace_id = ${ws} AND c.stage = 'lead' AND c.source IS DISTINCT FROM 'demo'
       AND c.created_at > NOW() - INTERVAL '30 days'
       AND NOT EXISTS (
         SELECT 1 FROM message_threads mt JOIN messages m ON m.thread_id = mt.id
          WHERE mt.workspace_id = c.workspace_id AND mt.client_id = c.id AND m.sender = 'biz')
     LIMIT ${MAX_PER_SIGNAL}`;
  return rows;
}
async function packages(ws) {
  const { rows } = await sql`
    SELECT cp.client_id, MIN(cp.credits_remaining)::int AS credits
      FROM client_packages cp
      JOIN clients c ON c.id = cp.client_id AND c.workspace_id = cp.workspace_id
     WHERE cp.workspace_id = ${ws} AND c.source IS DISTINCT FROM 'demo'
       AND ((cp.status = 'active' AND cp.credits_remaining = 1)
            OR (cp.status = 'exhausted' AND cp.updated_at > NOW() - INTERVAL '30 days'))
       AND NOT EXISTS (
         SELECT 1 FROM client_packages cp2
          WHERE cp2.workspace_id = cp.workspace_id AND cp2.client_id = cp.client_id
            AND cp2.id <> cp.id AND cp2.status = 'active' AND cp2.credits_remaining > 0)
       AND NOT EXISTS (
         SELECT 1 FROM bookings b
          WHERE b.workspace_id = cp.workspace_id AND b.client_id = cp.client_id
            AND b.cancelled_at IS NULL AND b.date >= CURRENT_DATE)
     GROUP BY cp.client_id
     LIMIT ${MAX_PER_SIGNAL}`;
  return rows;
}
async function quiet(ws) {
  const { rows } = await sql.query(
    `SELECT c.id AS client_id FROM clients c WHERE ${QUIET_CLIENT_WHERE} LIMIT ${MAX_PER_SIGNAL}`, [ws]);
  return rows;
}
const safe = (p) => p.catch((e) => { console.error('[clientAttention] signal failed:', e.message); return []; });

async function compute(workspaceId) {
  const [ov, un, le, pk, qu, fin] = await Promise.all([
    safe(overdue(workspaceId)), safe(unread(workspaceId)), safe(leads(workspaceId)),
    safe(packages(workspaceId)), safe(quiet(workspaceId)),
    sql`SELECT currency FROM finance_settings WHERE workspace_id = ${workspaceId}`.then((r) => r.rows[0]?.currency || 'USD').catch(() => 'USD'),
  ]);
  const by = new Map();   // clientId -> { overdue: {...}, message: {...}, ... }
  const put = (id, key, detail) => { if (!id) return; const cur = by.get(id) || {}; cur[key] = detail; by.set(id, cur); };

  for (const r of ov) {
    if (!(Number(r.owed) > 0)) continue;
    const late = r.oldest_due ? daysSince(r.oldest_due) : 0;
    put(r.client_id, 'overdue', {
      tone: 'danger',
      label: `Owes ${money(r.owed, fin)}${late >= 1 ? ` · ${plural(late, 'day')} overdue` : ' · overdue'}`,
    });
  }
  for (const r of un) {
    const d = daysSince(r.since);
    put(r.client_id, 'message', { tone: 'warn', label: d >= 1 ? `Sent you a message ${plural(d, 'day')} ago` : 'Sent you a message' });
  }
  for (const r of le) put(r.client_id, 'lead', { tone: 'warn', label: 'New lead · not contacted yet' });
  for (const r of pk) put(r.client_id, 'package', { tone: 'warn', label: Number(r.credits) === 1 ? '1 session left · nothing booked' : 'Out of sessions' });
  const weeks = Math.round(QUIET_DAYS / 7);
  for (const r of qu) put(r.client_id, 'quiet', { tone: 'muted', label: `No contact in ${weeks}+ weeks · nothing booked` });

  const out = {};
  for (const [id, reasons] of by) {
    const keys = ATTENTION_REASONS.filter((k) => reasons[k]);
    const top = reasons[keys[0]];
    out[id] = { key: keys[0], label: top.label, tone: top.tone, more: keys.length - 1 };
  }
  return out;
}

// { [clientId]: { key, label, tone, more } } for every client who needs
// something. Briefly cached per business.
export async function clientAttention(workspaceId) {
  if (!workspaceId) return {};
  return getOrSet(`client-attention:${workspaceId}`, TTL_MS, () => compute(workspaceId));
}

// The next upcoming booking for each of these clients: { [clientId]: { date, startMin } }.
export async function nextBookings(workspaceId, clientIds) {
  if (!workspaceId || !clientIds?.length) return {};
  const { rows } = await sql`
    SELECT DISTINCT ON (b.client_id) b.client_id, b.date::text AS date, b.start_min
      FROM bookings b
     WHERE b.workspace_id = ${workspaceId} AND b.client_id = ANY(${clientIds}::uuid[])
       AND b.cancelled_at IS NULL AND b.date >= CURRENT_DATE
     ORDER BY b.client_id, b.date ASC, b.start_min ASC`;
  const out = {};
  for (const r of rows) out[r.client_id] = { date: r.date, startMin: Number(r.start_min) };
  return out;
}
