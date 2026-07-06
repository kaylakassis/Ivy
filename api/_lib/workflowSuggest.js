// "Ivy noticed a pattern" — detects that an owner repeats the same manual
// follow-up and proposes a workflow that automates it. Deterministic SQL over
// the domain tables (there's no event log). Two triggers, tried in order:
//   • client_created  — an invoice / a document within 48h of a new client.
//   • booking_completed — a message to the client within 48h of a session being
//     marked complete (a personal thank-you / follow-up).
// Each fires when a strong majority of the last N match. Suppressed for a
// trigger once the owner already has an enabled workflow of that type, or once
// they dismiss the suggestion (signature stored in ui_prefs).
//
// The "invoice" habit auto-drafts a create_invoice when the fee is consistent
// (see consistentNewClientFee), else a create_task reminder — a nudge, never
// auto-billing. A "contract/document" habit maps to a real send_document action
// when a reused template is identifiable (by template_id or a consistent name
// that matches a template); when the name is consistent but matches no template
// it becomes a task that names the document, else a generic task.
import { sql } from './db.js';
import { validateWorkflowShape } from './workflows.js';

const WINDOW_HOURS = 48;      // "right after adding the client"
const LOOKBACK_DAYS = 120;    // only mine recent behavior
const SAMPLE_MIN = 5;         // need enough new clients to call it a pattern
const MAJORITY = 0.7;         // ≥70% of them got the same follow-up

// Returns a suggestion object { signature, headline, detail, workflow } or null.
// Tries the client_created habit first (invoice / document), then the
// booking_completed habit (a manual post-session follow-up). One card at a
// time; a dismissed signature falls through to the next trigger.
export async function detectWorkflowSuggestion(workspaceId, { dismissed = [] } = {}) {
  if (!workspaceId) return null;
  for (const detect of [detectClientCreatedSuggestion, detectBookingCompletedSuggestion]) {
    try {
      const s = await detect(workspaceId);
      if (s && !dismissed.includes(s.signature)) return s;
    } catch {
      // A suggestion is a nicety — never break the dashboard over it.
    }
  }
  return null;
}

// The client_created habit: an invoice and/or a document within WINDOW_HOURS of
// a new client. Returns a suggestion or null (caller applies the dismissal).
async function detectClientCreatedSuggestion(workspaceId) {
  if (!workspaceId) return null;
  {
    // Already automated new-client follow-ups? Don't nag.
    const has = await sql`
      SELECT EXISTS (
        SELECT 1 FROM workflows
         WHERE workspace_id = ${workspaceId} AND trigger_type = 'client_created' AND enabled
      ) AS has`;
    if (has.rows[0]?.has) return null;

    // Per-client: did an invoice / a sent document land within WINDOW_HOURS of
    // the client being added? Over the last N non-demo clients.
    const agg = await sql`
      WITH rc AS (
        SELECT id, created_at FROM clients
         WHERE workspace_id = ${workspaceId}
           AND (source IS DISTINCT FROM 'demo')
           AND created_at > NOW() - (${LOOKBACK_DAYS} || ' days')::interval
         ORDER BY created_at DESC
         LIMIT 20
      ), pc AS (
        SELECT rc.id,
          EXISTS (SELECT 1 FROM invoices i
                   WHERE i.workspace_id = ${workspaceId} AND i.client_id = rc.id
                     AND i.created_at BETWEEN rc.created_at
                                          AND rc.created_at + (${WINDOW_HOURS} || ' hours')::interval) AS inv,
          EXISTS (SELECT 1 FROM documents d
                   WHERE d.workspace_id = ${workspaceId} AND d.recipient_client_id = rc.id
                     AND d.status IN ('sent', 'completed')
                     AND COALESCE(d.sent_at, d.created_at) BETWEEN rc.created_at
                                          AND rc.created_at + (${WINDOW_HOURS} || ' hours')::interval) AS doc
          FROM rc
      )
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE inv)::int AS inv_n,
             COUNT(*) FILTER (WHERE doc)::int AS doc_n
        FROM pc`;
    const { total, inv_n: invN, doc_n: docN } = agg.rows[0] || { total: 0, inv_n: 0, doc_n: 0 };
    if (Number(total) < SAMPLE_MIN) return null;

    const threshold = Math.ceil(Number(total) * MAJORITY);
    const invoiceHabit = Number(invN) >= threshold;
    const docHabit = Number(docN) >= threshold;
    if (!invoiceHabit && !docHabit) return null;

    const sigParts = [];
    const actions = [];
    const habits = [];

    if (invoiceHabit) {
      sigParts.push('invoice');
      // Only auto-DRAFT the invoice when the fee is consistent — i.e. a strong
      // majority of recently-invoiced new clients got the SAME single-line-item
      // amount. That's the one case where the amount is safe to infer. When it
      // varies, fall back to a task reminder (never guess an amount to bill).
      const fee = await consistentNewClientFee(workspaceId, Number(invN));
      if (fee) {
        habits.push(`draft a $${fee.rate.toLocaleString()} invoice`);
        actions.push({
          type: 'create_invoice',
          config: {
            items: [{ description: fee.description, quantity: 1, rate: fee.rate }],
            dueInDays: 14,
          },
        });
      } else {
        habits.push('send an invoice');
        actions.push({
          type: 'create_task',
          config: {
            title: 'Send invoice to {{clientName}}',
            notes: 'Ivy set this up because you invoice new clients. (Your amounts vary, so this reminds you to send it rather than guessing a total.)',
            dueInDays: 1,
          },
        });
      }
    }

    if (docHabit) {
      sigParts.push('document');
      // Prefer a real send_document action when the same document is clearly
      // reused — either linked by template_id (intake forms) or by a consistent
      // name that matches one of the owner's templates. When the name is
      // consistent but no template matches, name it in the task reminder so it's
      // specific; otherwise fall back to a generic reminder.
      const doc = await consistentNewClientDocument(workspaceId, Number(docN));
      if (doc?.templateId) {
        habits.push('send a document');
        actions.push({ type: 'send_document', config: { templateId: doc.templateId } });
      } else if (doc?.name) {
        habits.push(`send your ${doc.name}`);
        actions.push({
          type: 'create_task',
          config: { title: `Send {{clientName}} your ${doc.name}`, dueInDays: 1 },
        });
      } else {
        habits.push('send a document');
        actions.push({
          type: 'create_task',
          config: { title: 'Send {{clientName}} your usual document', dueInDays: 1 },
        });
      }
    }

    const signature = `client_created:${sigParts.join('+')}`;

    const workflow = {
      name: 'New-client follow-up',
      description: 'Suggested by Ivy from your recent habits.',
      triggerType: 'client_created',
      triggerConfig: {},
      actions,
      enabled: true,
    };
    // Defensive: never surface a proposal the create endpoint would reject.
    try { validateWorkflowShape(workflow); } catch { return null; }

    const habitText = habits.length === 2 ? `${habits[0]} and ${habits[1]}` : habits[0];
    return {
      signature,
      headline: 'Ivy noticed a pattern',
      detail: `You ${habitText} for ${Math.max(invN, docN)} of your last ${total} new clients. Want Ivy to do it automatically every time you add one?`,
      workflow,
    };
  }
}

// The booking_completed habit: the owner personally follows up (a message in the
// client's thread) within WINDOW_HOURS after a booking is marked complete.
// Review requests are already automated app-wide (see cron/review-requests.js),
// so we only surface the MANUAL follow-up. The message wording varies, so we
// propose a task reminder rather than auto-sending invented content — the owner
// can upgrade it to an automatic email in Workflows.
async function detectBookingCompletedSuggestion(workspaceId) {
  if (!workspaceId) return null;
  const has = await sql`
    SELECT EXISTS (
      SELECT 1 FROM workflows
       WHERE workspace_id = ${workspaceId} AND trigger_type = 'booking_completed' AND enabled
    ) AS has`;
  if (has.rows[0]?.has) return null;

  // Recent completed bookings (a completion_log entry within LOOKBACK_DAYS), not
  // cancelled / no-show, tied to a client thread. For each, did the owner send a
  // message (sender='biz') within WINDOW_HOURS after the latest completion?
  const agg = await sql`
    WITH rb AS (
      SELECT b.id, b.client_id,
             MAX((e.value->>'completedAt')::timestamptz) AS completed_at
        FROM bookings b
        CROSS JOIN LATERAL jsonb_each(b.completion_log) AS e(key, value)
       WHERE b.workspace_id = ${workspaceId}
         AND b.cancelled_at IS NULL
         AND b.no_show_at IS NULL
         AND b.client_id IS NOT NULL
         AND b.completion_log <> '{}'::jsonb
         AND (e.value->>'completedAt') IS NOT NULL
       GROUP BY b.id, b.client_id
      HAVING MAX((e.value->>'completedAt')::timestamptz) > NOW() - (${LOOKBACK_DAYS} || ' days')::interval
       ORDER BY completed_at DESC
       LIMIT 20
    ), fb AS (
      SELECT rb.id,
        EXISTS (
          SELECT 1 FROM message_threads mt
            JOIN messages m ON m.thread_id = mt.id
           WHERE mt.workspace_id = ${workspaceId} AND mt.client_id = rb.client_id
             AND m.sender = 'biz'
             AND m.created_at BETWEEN rb.completed_at
                                  AND rb.completed_at + (${WINDOW_HOURS} || ' hours')::interval
        ) AS followed
        FROM rb
    )
    SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE followed)::int AS followed_n
      FROM fb`;
  const { total, followed_n: followedN } = agg.rows[0] || { total: 0, followed_n: 0 };
  if (Number(total) < SAMPLE_MIN) return null;
  if (Number(followedN) < Math.ceil(Number(total) * MAJORITY)) return null;

  const workflow = {
    name: 'Post-session follow-up',
    description: 'Suggested by Ivy from your recent habits.',
    triggerType: 'booking_completed',
    triggerConfig: { daysAfter: 1 },
    actions: [{
      type: 'create_task',
      config: {
        title: 'Follow up with {{clientName}} after their session',
        notes: 'Ivy set this up because you message clients after their sessions. Turn it into an automatic email in Workflows if you’d like Ivy to send it for you.',
        dueInDays: 1,
      },
    }],
    enabled: true,
  };
  // Defensive: never surface a proposal the create endpoint would reject.
  try { validateWorkflowShape(workflow); } catch { return null; }

  return {
    signature: 'booking_completed:followup',
    headline: 'Ivy noticed a pattern',
    detail: `You followed up with ${followedN} of your last ${total} clients after their session. Want Ivy to remind you every time a booking wraps?`,
    workflow,
  };
}

// At least this many recently-invoiced new clients must share the SAME amount
// before we'll auto-draft it (on top of the MAJORITY share) — a couple of
// coincidental matches shouldn't trigger real billing.
const CONSISTENT_FEE_MIN = 3;

// Returns { rate, description } when a strong majority of recently-invoiced new
// clients got the SAME single-line-item amount (a fixed onboarding fee), else
// null. Looks at each recent client's FIRST invoice within the window; only
// single-item invoices count (multi-line invoices vary, so we don't infer).
async function consistentNewClientFee(workspaceId, invoicedCount) {
  const { rows } = await sql`
    WITH rc AS (
      SELECT id, created_at FROM clients
       WHERE workspace_id = ${workspaceId}
         AND (source IS DISTINCT FROM 'demo')
         AND created_at > NOW() - (${LOOKBACK_DAYS} || ' days')::interval
       ORDER BY created_at DESC
       LIMIT 20
    ), firstinv AS (
      SELECT (
        SELECT i.items FROM invoices i
         WHERE i.workspace_id = ${workspaceId} AND i.client_id = rc.id
           AND i.created_at BETWEEN rc.created_at
                                AND rc.created_at + (${WINDOW_HOURS} || ' hours')::interval
         ORDER BY i.created_at ASC LIMIT 1
      ) AS items
      FROM rc
    ), single AS (
      SELECT (items->0->>'rate')::numeric AS rate,
             NULLIF(btrim(items->0->>'description'), '') AS descr
        FROM firstinv
       WHERE items IS NOT NULL AND jsonb_array_length(items) = 1
    )
    SELECT rate::float8 AS rate,
           COUNT(*)::int AS n,
           (CASE WHEN COUNT(DISTINCT descr) = 1 THEN MAX(descr) ELSE NULL END) AS common_descr
      FROM single
     WHERE rate IS NOT NULL AND rate > 0
     GROUP BY rate
     ORDER BY n DESC
     LIMIT 1`;
  const top = rows[0];
  if (!top) return null;
  const n = Number(top.n);
  const need = Math.max(CONSISTENT_FEE_MIN, Math.ceil(Number(invoicedCount) * MAJORITY));
  if (n < need) return null;
  const rate = Math.round(Number(top.rate) * 100) / 100;
  if (!Number.isFinite(rate) || rate <= 0) return null;
  return {
    rate,
    // Reuse their own wording when every matching invoice used the same line;
    // otherwise a neutral, client-personalized default.
    description: top.common_descr || 'Services for {{clientName}}',
  };
}

// At least this many recently-doc'd new clients must share the same template /
// document before we propose sending it automatically (on top of MAJORITY).
const DOC_CONSISTENT_MIN = 3;

// Returns { templateId } when the owner reuses the SAME document for new clients
// — strongest when linked by template_id (intake forms), else when the sent
// documents share a consistent NAME that matches one of their templates. When
// the name is consistent but matches no template, returns { name } so the
// reminder can name it. Returns null when documents vary. Looks at each recent
// new client's FIRST in-window sent document.
async function consistentNewClientDocument(workspaceId, docCount) {
  const need = Math.max(DOC_CONSISTENT_MIN, Math.ceil(Number(docCount) * MAJORITY));

  // 1) Strongest signal: the same template reused via template_id (e.g. intake
  //    forms). Count DISTINCT clients so multiple docs per client don't inflate.
  const byId = await sql`
    WITH rc AS (
      SELECT id, created_at FROM clients
       WHERE workspace_id = ${workspaceId}
         AND (source IS DISTINCT FROM 'demo')
         AND created_at > NOW() - (${LOOKBACK_DAYS} || ' days')::interval
       ORDER BY created_at DESC
       LIMIT 20
    )
    SELECT d.template_id AS id, COUNT(DISTINCT rc.id)::int AS n
      FROM rc
      JOIN documents d ON d.recipient_client_id = rc.id AND d.workspace_id = ${workspaceId}
      JOIN documents t ON t.id = d.template_id AND t.workspace_id = ${workspaceId} AND t.is_template = TRUE
     WHERE d.status IN ('sent', 'completed')
       AND COALESCE(d.sent_at, d.created_at) BETWEEN rc.created_at
                                          AND rc.created_at + (${WINDOW_HOURS} || ' hours')::interval
     GROUP BY d.template_id
     ORDER BY n DESC
     LIMIT 1`;
  if (byId.rows[0]?.id && Number(byId.rows[0].n) >= need) {
    return { templateId: byId.rows[0].id };
  }

  // 2) Fallback: a consistent document NAME across those first docs. Strip a
  //    trailing " - <client name>" (how send_document names its clones) to get
  //    the base name, then match it to one of the owner's templates if present.
  const byName = await sql`
    WITH rc AS (
      SELECT id, name, created_at FROM clients
       WHERE workspace_id = ${workspaceId}
         AND (source IS DISTINCT FROM 'demo')
         AND created_at > NOW() - (${LOOKBACK_DAYS} || ' days')::interval
       ORDER BY created_at DESC
       LIMIT 20
    ), firstdoc AS (
      SELECT rc.name AS client_name, fd.name AS doc_name
        FROM rc
        JOIN LATERAL (
          SELECT d.name
            FROM documents d
           WHERE d.workspace_id = ${workspaceId} AND d.recipient_client_id = rc.id
             AND d.status IN ('sent', 'completed')
             AND COALESCE(d.sent_at, d.created_at) BETWEEN rc.created_at
                                          AND rc.created_at + (${WINDOW_HOURS} || ' hours')::interval
           ORDER BY COALESCE(d.sent_at, d.created_at) ASC
           LIMIT 1
        ) fd ON TRUE
    ), base AS (
      SELECT btrim(
               CASE WHEN client_name IS NOT NULL AND btrim(client_name) <> ''
                         AND doc_name LIKE ('% - ' || client_name)
                    THEN left(doc_name, length(doc_name) - length(' - ' || client_name))
                    ELSE doc_name END
             ) AS base_name
        FROM firstdoc
    ), grp AS (
      SELECT lower(base_name) AS norm, MAX(base_name) AS display, COUNT(*)::int AS n
        FROM base
       WHERE base_name <> ''
       GROUP BY lower(base_name)
       ORDER BY n DESC
       LIMIT 1
    )
    SELECT g.display AS name, g.n,
           (SELECT t.id FROM documents t
             WHERE t.workspace_id = ${workspaceId} AND t.is_template = TRUE
               AND lower(btrim(t.name)) = g.norm
             ORDER BY t.created_at DESC
             LIMIT 1) AS template_id
      FROM grp g`;
  const top = byName.rows[0];
  if (!top || Number(top.n) < need) return null;
  if (top.template_id) return { templateId: top.template_id };
  const name = String(top.name || '').trim();
  return name ? { name } : null;
}

// The owner's dismissed suggestion signatures (stored on the workspace owner's
// users.ui_prefs). Best-effort — an empty list on any error so a lookup problem
// never suppresses a real suggestion nor throws into a caller.
export async function dismissedWorkflowSuggestions(workspaceId) {
  if (!workspaceId) return [];
  try {
    const { rows } = await sql`
      SELECT u.ui_prefs->'dismissedWorkflowSuggestions' AS d
        FROM workspaces w JOIN users u ON u.id = w.owner_id
       WHERE w.id = ${workspaceId}`;
    const d = rows[0]?.d;
    return Array.isArray(d) ? d : [];
  } catch {
    return [];
  }
}

// The concrete evidence behind the CURRENT suggestion — the actual clients /
// sessions, counts, and how consistent it is — so Ivy (or the owner) can see WHY
// a pattern was flagged instead of taking it on faith. Returns null when there's
// no suggestion. ID-free: names and dates only, never a raw row id. Examples are
// capped so the payload stays small.
export async function explainWorkflowSuggestion(workspaceId, { dismissed = [] } = {}) {
  const suggestion = await detectWorkflowSuggestion(workspaceId, { dismissed });
  if (!suggestion) return null;
  const trigger = suggestion.workflow?.triggerType;
  const base = { signature: suggestion.signature, trigger, detail: suggestion.detail, windowHours: WINDOW_HOURS, habits: [] };

  if (trigger === 'client_created') {
    const { rows } = await sql`
      WITH rc AS (
        SELECT id, name, created_at FROM clients
         WHERE workspace_id = ${workspaceId}
           AND (source IS DISTINCT FROM 'demo')
           AND created_at > NOW() - (${LOOKBACK_DAYS} || ' days')::interval
         ORDER BY created_at DESC
         LIMIT 20
      )
      SELECT rc.name AS client,
             inv.number AS inv_number, inv.total AS inv_total, inv.rate AS inv_rate, inv.dt AS inv_dt,
             doc.name AS doc_name, doc.dt AS doc_dt
        FROM rc
        LEFT JOIN LATERAL (
          SELECT i.number, i.total,
                 CASE WHEN jsonb_array_length(i.items) = 1 THEN (i.items->0->>'rate')::numeric END AS rate,
                 to_char(i.created_at, 'Mon FMDD') AS dt
            FROM invoices i
           WHERE i.workspace_id = ${workspaceId} AND i.client_id = rc.id
             AND i.created_at BETWEEN rc.created_at
                                  AND rc.created_at + (${WINDOW_HOURS} || ' hours')::interval
           ORDER BY i.created_at ASC LIMIT 1
        ) inv ON TRUE
        LEFT JOIN LATERAL (
          SELECT d.name, to_char(COALESCE(d.sent_at, d.created_at), 'Mon FMDD') AS dt
            FROM documents d
           WHERE d.workspace_id = ${workspaceId} AND d.recipient_client_id = rc.id
             AND d.status IN ('sent', 'completed')
             AND COALESCE(d.sent_at, d.created_at) BETWEEN rc.created_at
                                  AND rc.created_at + (${WINDOW_HOURS} || ' hours')::interval
           ORDER BY COALESCE(d.sent_at, d.created_at) ASC LIMIT 1
        ) doc ON TRUE`;
    const considered = rows.length;
    base.considered = considered;
    base.consideredLabel = 'most recent new clients';

    if (suggestion.signature.includes('invoice')) {
      const inv = rows.filter((r) => r.inv_number != null);
      const rates = [...new Set(inv.map((r) => (r.inv_rate == null ? null : Number(r.inv_rate))).filter((x) => x != null && x > 0))];
      const habit = {
        kind: 'invoice',
        label: 'sent an invoice within 48h of adding the client',
        matched: inv.length,
        of: considered,
        sharePct: considered ? Math.round((inv.length / considered) * 100) : 0,
        examples: inv.slice(0, 4).map((r) => `${r.client} — ${r.inv_number}${r.inv_total != null ? `, $${Number(r.inv_total).toLocaleString()}` : ''} (${r.inv_dt})`),
      };
      if (rates.length === 1) habit.note = `every one was for $${rates[0].toLocaleString()} — a consistent fee, which is why Ivy can safely auto-draft it`;
      else if (rates.length > 1) habit.note = 'the amounts vary, so Ivy proposes a reminder to send it rather than guessing a total';
      base.habits.push(habit);
    }
    if (suggestion.signature.includes('document')) {
      const docs = rows.filter((r) => r.doc_name != null);
      base.habits.push({
        kind: 'document',
        label: 'sent a document within 48h of adding the client',
        matched: docs.length,
        of: considered,
        sharePct: considered ? Math.round((docs.length / considered) * 100) : 0,
        examples: docs.slice(0, 4).map((r) => `${r.client} — “${r.doc_name}” (${r.doc_dt})`),
      });
    }
  } else if (trigger === 'booking_completed') {
    const { rows } = await sql`
      WITH rb AS (
        SELECT b.id, b.client_id, b.client_name,
               MAX((e.value->>'completedAt')::timestamptz) AS completed_at
          FROM bookings b
          CROSS JOIN LATERAL jsonb_each(b.completion_log) AS e(key, value)
         WHERE b.workspace_id = ${workspaceId}
           AND b.cancelled_at IS NULL AND b.no_show_at IS NULL
           AND b.client_id IS NOT NULL AND b.completion_log <> '{}'::jsonb
           AND (e.value->>'completedAt') IS NOT NULL
         GROUP BY b.id, b.client_id, b.client_name
        HAVING MAX((e.value->>'completedAt')::timestamptz) > NOW() - (${LOOKBACK_DAYS} || ' days')::interval
         ORDER BY completed_at DESC
         LIMIT 20
      )
      SELECT rb.client_name AS client,
             to_char(rb.completed_at, 'Mon FMDD') AS dt,
             EXISTS (
               SELECT 1 FROM message_threads mt
                 JOIN messages m ON m.thread_id = mt.id
                WHERE mt.workspace_id = ${workspaceId} AND mt.client_id = rb.client_id
                  AND m.sender = 'biz'
                  AND m.created_at BETWEEN rb.completed_at
                                       AND rb.completed_at + (${WINDOW_HOURS} || ' hours')::interval
             ) AS followed
        FROM rb`;
    const considered = rows.length;
    const followed = rows.filter((r) => r.followed);
    base.considered = considered;
    base.consideredLabel = 'most recent completed sessions';
    base.habits.push({
      kind: 'followup',
      label: 'messaged the client within 48h of the session being marked complete',
      matched: followed.length,
      of: considered,
      sharePct: considered ? Math.round((followed.length / considered) * 100) : 0,
      examples: followed.slice(0, 4).map((r) => `${r.client} (session ${r.dt})`),
    });
  }

  return base;
}

// Plain-English, ID-free one-liners for a suggestion's actions — safe to hand to
// Ivy's context or show the owner. Mirrors the dashboard card's describeAction
// but never leaks a template_id or other internal identifier.
export function describeSuggestionActions(actions = []) {
  return (Array.isArray(actions) ? actions : []).map((a) => {
    const c = (a && a.config) || {};
    switch (a && a.type) {
      case 'create_task':   return `add a task ("${c.title || 'Follow up'}")`;
      case 'send_document': return 'send your usual document';
      case 'create_invoice': {
        const rate = Number(c.items?.[0]?.rate);
        return Number.isFinite(rate) && rate > 0
          ? `draft a $${rate.toLocaleString()} invoice (you review + send)`
          : 'draft their invoice (you review + send)';
      }
      case 'send_email': return `email them ("${c.subject || 'a message'}")`;
      case 'send_sms':   return 'text them';
      default:           return String((a && a.type) || 'do something');
    }
  });
}
