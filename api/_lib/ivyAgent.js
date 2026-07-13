// Ivy proactive agent. Detects overnight signals per workspace and stores them
// as PENDING ivy_suggestions the owner can act on in one tap ("Ivy noticed X →
// approve?"). Each detector is one query and returns 0-1 suggestion. Idempotent:
// storeSuggestions upserts ON CONFLICT (workspace_id, dedupe_key) DO NOTHING and
// dedupe_key encodes the owner-local date, so a signal suggests at most once a
// day and can re-suggest tomorrow if still true.
//
// Acting on a suggestion just opens Ivy with its pre-filled `prompt` - it runs
// through Ivy's normal tools + confirm-gate, so this adds NO new execution path
// and nothing sends without the owner's approval.
import { sql } from './db.js';
import { workspaceTimeZone } from './calendar.js';

export async function detectSuggestions(workspaceId) {
  const tz = await workspaceTimeZone(workspaceId);
  const today = (await sql`SELECT (NOW() AT TIME ZONE ${tz})::date::text AS d`).rows[0].d;
  const out = [];

  // 1) Overdue invoices — chase money that's already late.
  const od = (await sql`
    SELECT COUNT(*)::int AS n, COALESCE(SUM(total), 0)::numeric AS owed
      FROM invoices WHERE workspace_id = ${workspaceId} AND status = 'overdue'`).rows[0];
  if (Number(od.n) > 0) {
    const owed = Math.round(Number(od.owed));
    out.push({
      kind: 'overdue_invoices',
      dedupe_key: `overdue:${today}`,
      icon: 'Dollar',
      title: `${od.n} invoice${od.n === 1 ? '' : 's'} overdue`,
      detail: owed > 0
        ? `$${owed.toLocaleString()} outstanding. Want Ivy to draft friendly reminders?`
        : 'Want Ivy to draft friendly reminders?',
      prompt: 'Draft friendly payment reminders for my overdue invoices.',
    });
  }

  // 2) A fresh review (last ~26h) — amplify a win or triage a low rating.
  const rv = (await sql`
    SELECT id, reviewer_name, rating FROM reviews
     WHERE workspace_id = ${workspaceId} AND status = 'visible'
       AND created_at >= NOW() - INTERVAL '26 hours'
     ORDER BY created_at DESC LIMIT 1`).rows[0];
  if (rv) {
    const name = rv.reviewer_name || 'A client';
    if (rv.rating >= 4) {
      out.push({
        kind: 'new_review', dedupe_key: `review:${rv.id}`, icon: 'Heart',
        title: `New ${rv.rating}-star review from ${name}`,
        detail: "Want Ivy to thank them and ask if they'd refer a friend?",
        prompt: `Draft a warm thank-you to ${name} for their ${rv.rating}-star review, and gently ask if they'd refer a friend.`,
      });
    } else if (rv.rating <= 2) {
      out.push({
        kind: 'new_review', dedupe_key: `review:${rv.id}`, icon: 'Chat',
        title: `New ${rv.rating}-star review from ${name}`,
        detail: 'A low rating just came in — want help responding?',
        prompt: `Help me write a calm, professional response to ${name}'s ${rv.rating}-star review.`,
      });
    }
  }

  // 3) Leads waiting on a reply (created 20h+ ago, no owner message yet).
  const ld = (await sql`
    SELECT COUNT(*)::int AS n FROM clients c
     WHERE c.workspace_id = ${workspaceId} AND c.stage = 'lead'
       AND c.created_at < NOW() - INTERVAL '20 hours'
       AND NOT EXISTS (
         SELECT 1 FROM message_threads mt JOIN messages m ON m.thread_id = mt.id
          WHERE mt.workspace_id = c.workspace_id AND mt.client_id = c.id AND m.sender = 'biz')`).rows[0];
  if (Number(ld.n) > 0) {
    out.push({
      kind: 'unreplied_leads', dedupe_key: `leads:${today}`, icon: 'Users',
      title: `${ld.n} lead${ld.n === 1 ? '' : 's'} waiting on a reply`,
      detail: 'Speed to reply is the #1 close driver — want Ivy to help you follow up?',
      prompt: "Help me follow up with the new leads I haven't replied to yet.",
    });
  }

  // 4) Quiet calendar next 7 days (only when there are active clients to fill it).
  const cal = (await sql`
    SELECT
      (SELECT COUNT(*)::int FROM bookings b
        WHERE b.workspace_id = ${workspaceId} AND b.cancelled_at IS NULL
          AND b.date >= (NOW() AT TIME ZONE ${tz})::date
          AND b.date <  (NOW() AT TIME ZONE ${tz})::date + 7) AS upcoming,
      (SELECT COUNT(*)::int FROM clients
        WHERE workspace_id = ${workspaceId} AND stage = 'active') AS active`).rows[0];
  if (Number(cal.active) >= 3 && Number(cal.upcoming) <= 2) {
    out.push({
      kind: 'calendar_gap', dedupe_key: `gap:${today}`, icon: 'Calendar',
      title: `Next 7 days are quiet — ${cal.upcoming} session${cal.upcoming === 1 ? '' : 's'} booked`,
      detail: 'Want Ivy to draft a campaign to fill the gaps with your quiet clients?',
      prompt: "Draft a campaign to fill next week's open slots, targeting my quiet clients.",
    });
  }

  return out;
}

// Upsert pending suggestions; ON CONFLICT (workspace, dedupe_key) DO NOTHING so
// the same signal never piles up. Returns the count newly created.
export async function storeSuggestions(workspaceId, suggestions) {
  let created = 0;
  for (const s of suggestions) {
    // eslint-disable-next-line no-await-in-loop
    const r = await sql`
      INSERT INTO ivy_suggestions (workspace_id, kind, dedupe_key, icon, title, detail, prompt)
      VALUES (${workspaceId}, ${s.kind}, ${s.dedupe_key}, ${s.icon || null}, ${s.title}, ${s.detail || null}, ${s.prompt})
      ON CONFLICT (workspace_id, dedupe_key) DO NOTHING
      RETURNING id`;
    if (r.rows.length) created++;
  }
  return created;
}

export async function runIvyAgentForWorkspace(workspaceId) {
  const suggestions = await detectSuggestions(workspaceId);
  if (!suggestions.length) return { created: 0 };
  return { created: await storeSuggestions(workspaceId, suggestions) };
}

// The owner's current pending suggestions (newest first).
export async function listPendingSuggestions(workspaceId, { limit = 10 } = {}) {
  const { rows } = await sql`
    SELECT id, kind, icon, title, detail, prompt, created_at
      FROM ivy_suggestions
     WHERE workspace_id = ${workspaceId} AND status = 'pending'
     ORDER BY created_at DESC LIMIT ${limit}`;
  return rows;
}

// Resolve one suggestion (owner acted on it or dismissed it), workspace-scoped.
export async function resolveSuggestion(workspaceId, id, action) {
  const status = action === 'done' ? 'done' : 'dismissed';
  const r = await sql`
    UPDATE ivy_suggestions SET status = ${status}, acted_at = NOW()
     WHERE id = ${id} AND workspace_id = ${workspaceId} AND status = 'pending'
     RETURNING id`;
  return r.rows.length > 0;
}
