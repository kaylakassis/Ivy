// Ivy Pro: workspace data context + reply generation.
// Today: deterministic mock replies grounded in the user's real numbers.
// Later: same `generateReply()` signature switches to a real Anthropic call.
//
// Crucially, the reply runs server-side so we can (a) include private
// workspace data without exposing API keys to the browser and (b) keep
// each workspace's conversation isolated.
import { sql } from './db.js';

export function serializeSession(row, lastPreview) {
  if (!row) return null;
  return {
    id:                  row.id,
    title:               row.title,
    lastMessageAt:       row.last_message_at,
    lastMessagePreview:  lastPreview ?? row.last_message_preview ?? null,
    createdAt:           row.created_at,
    updatedAt:           row.updated_at,
  };
}

export function serializeMessage(row) {
  if (!row) return null;
  return {
    id:        row.id,
    role:      row.role,
    text:      row.text,
    createdAt: row.created_at,
  };
}

// Pulls the same numbers Ivy reasons over, so the right-hand "What Ivy sees"
// panel stays in lockstep with the prompt context.
export async function workspaceContext(workspaceId) {
  const { rows: r1 } = await sql`
    SELECT COALESCE(SUM(
      GREATEST(
        (SELECT COALESCE(SUM((it->>'quantity')::numeric * (it->>'rate')::numeric), 0)
          FROM jsonb_array_elements(items) AS it) - discount,
        0
      ) * (1 + tax_rate / 100)
    ), 0)::numeric AS revenue
    FROM invoices
    WHERE workspace_id = ${workspaceId}
      AND status = 'paid'
      AND paid_at >= date_trunc('month', NOW())
  `;
  const { rows: r2 } = await sql`
    SELECT
      COUNT(*) FILTER (WHERE status IN ('sent','overdue'))::int AS open_invoices,
      COUNT(*)::int AS total
    FROM invoices WHERE workspace_id = ${workspaceId}
  `;
  const { rows: r3 } = await sql`
    SELECT COUNT(*)::int AS active_clients FROM clients
    WHERE workspace_id = ${workspaceId} AND stage = 'active'
  `;
  const { rows: r4 } = await sql`
    SELECT COUNT(*)::int AS upcoming FROM bookings
    WHERE workspace_id = ${workspaceId}
      AND cancelled_at IS NULL
      AND date >= CURRENT_DATE
      AND date <  (CURRENT_DATE + INTERVAL '7 days')::date
  `;
  const { rows: r5 } = await sql`
    SELECT COUNT(*)::int AS quiet FROM clients c
    WHERE c.workspace_id = ${workspaceId}
      AND c.stage = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM message_threads mt
        JOIN messages m ON m.thread_id = mt.id
        WHERE mt.workspace_id = c.workspace_id
          AND mt.client_id = c.id
          AND m.created_at >= NOW() - INTERVAL '21 days'
      )
  `;

  return {
    revenueThisMonth: Number(r1[0].revenue || 0),
    openInvoices:     Number(r2[0].open_invoices || 0),
    activeClients:    Number(r3[0].active_clients || 0),
    upcomingSessions: Number(r4[0].upcoming || 0),
    quietClients:     Number(r5[0].quiet || 0),
  };
}

// Mock reply: deterministic templates that quote real numbers. Designed so the
// later switch to Anthropic is a one-line change in api/ivy/index.js.
export function generateReply(text, ctx) {
  const t = (text || '').toLowerCase();
  const fmt$ = (n) => '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });

  if (t.includes('revenue') || t.includes('money') || t.includes('income')) {
    return `You're at ${fmt$(ctx.revenueThisMonth)} in paid revenue this month. ${
      ctx.openInvoices > 0
        ? `There are ${ctx.openInvoices} open invoice${ctx.openInvoices === 1 ? '' : 's'} — chasing those could unlock a quick boost.`
        : 'No open invoices right now.'
    } Want me to help draft a follow-up message?`;
  }
  if (t.includes('retention') || t.includes('churn') || t.includes('quiet')) {
    return `Retention is about rhythm. Of your ${ctx.activeClients} active client${ctx.activeClients === 1 ? '' : 's'}, ${ctx.quietClients} haven't heard from you in 3+ weeks. Clients who go that long without a touchpoint are 4× more likely to churn. Want a draft of a light check-in to send them?`;
  }
  if (t.includes('pricing') || t.includes('rates') || t.includes('raise')) {
    return `A simple rule: raise rates when you're >70% booked for 4 weeks straight. You have ${ctx.upcomingSessions} session${ctx.upcomingSessions === 1 ? '' : 's'} on the books in the next 7 days. If your calendar's been steadily full, that's a green light. Want me to walk through a 10–15% increase plan?`;
  }
  if (t.includes('lead') || t.includes('acquisition') || t.includes('grow')) {
    return `Three high-leverage moves this week:\n\n1. Post a short case study of a client win on socials.\n2. Email your 10 most engaged past clients asking for a referral.\n3. Sharpen the CTA on your homepage — one offer, one button.\n\nWant me to draft any of these?`;
  }
  if (t.includes('content') || t.includes('post') || t.includes('social')) {
    return `Try a 4-week sprint with one theme per week — ‘before/after', ‘FAQ', ‘behind the scenes', ‘client win'. Three short posts a week, repurposable to email and stories. Want me to sketch the calendar?`;
  }
  if (t.includes('weekly plan') || t.includes('this week') || t.includes('three things')) {
    const moves = [];
    if (ctx.openInvoices > 0) moves.push(`Chase the ${ctx.openInvoices} open invoice${ctx.openInvoices === 1 ? '' : 's'} (${fmt$(ctx.revenueThisMonth)} booked so far this month).`);
    if (ctx.quietClients > 0)  moves.push(`Send a check-in to ${ctx.quietClients} quiet client${ctx.quietClients === 1 ? '' : 's'} — they're at risk.`);
    if (ctx.upcomingSessions > 0) moves.push(`Pre-confirm your ${ctx.upcomingSessions} upcoming session${ctx.upcomingSessions === 1 ? '' : 's'} the day before — reduces no-shows.`);
    while (moves.length < 3) moves.push('Pick one piece of content to ship — the smallest one you've been putting off.');
    return `Three things this week:\n\n${moves.slice(0, 3).map((m, i) => `${i + 1}. ${m}`).join('\n')}\n\nWant me to break any of these down?`;
  }
  if (t.includes('analyze') && (t.includes('report') || t.includes('upload'))) {
    return `Uploads are coming soon — once they're live I'll parse CSVs and PDFs and pull out (1) top 3 revenue sources, (2) any segment with > 15% drop, (3) any cost line growing faster than revenue. For now, paste the numbers in chat and I'll dig in.`;
  }
  if (t.length < 30) {
    return `Happy to dig in. A little more context would help — what outcome are you after?`;
  }
  return `Here's how I'd approach this: name the single number that would move most if this worked. Your snapshot: ${fmt$(ctx.revenueThisMonth)} revenue this month, ${ctx.activeClients} active clients, ${ctx.upcomingSessions} sessions in the next 7 days. Want three options or one sharp recommendation rooted in those?`;
}

export async function fetchOwnedSession({ id, workspaceId }) {
  if (!id) return null;
  const { rows } = await sql`
    SELECT * FROM ivy_sessions WHERE id = ${id} AND workspace_id = ${workspaceId}
  `;
  return rows[0] || null;
}
