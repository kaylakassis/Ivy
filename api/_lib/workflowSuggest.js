// "Ivy noticed a pattern" — detects that an owner repeats the same manual
// follow-up after adding a client (e.g. always sends an invoice + a contract),
// and proposes a client_created workflow that automates it. Deterministic SQL
// over the domain tables (there's no event log) — joins the last N clients to
// the invoices/documents created within 48h of each, and fires when a strong
// majority match. Suppressed once an owner already has a client_created
// workflow, or once they dismiss the suggestion (signature stored in ui_prefs).
//
// The engine has no invoice action today, so the "invoice" habit is proposed as
// a create_task reminder ("Send invoice to {client}") — a nudge, not auto-
// billing. A "contract/document" habit maps to a real send_document action when
// a reused template is identifiable, else to a task.
import { sql } from './db.js';
import { validateWorkflowShape } from './workflows.js';

const WINDOW_HOURS = 48;      // "right after adding the client"
const LOOKBACK_DAYS = 120;    // only mine recent behavior
const SAMPLE_MIN = 5;         // need enough new clients to call it a pattern
const MAJORITY = 0.7;         // ≥70% of them got the same follow-up

// Returns a suggestion object { signature, headline, detail, workflow } or null.
export async function detectWorkflowSuggestion(workspaceId, { dismissed = [] } = {}) {
  if (!workspaceId) return null;
  try {
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
      habits.push('send a document');
      // Prefer a real send_document action when a reused template is clear.
      const tmpl = await sql`
        SELECT d.template_id AS id, COUNT(*)::int AS n
          FROM clients c
          JOIN documents d ON d.recipient_client_id = c.id AND d.workspace_id = ${workspaceId}
          JOIN documents t ON t.id = d.template_id AND t.workspace_id = ${workspaceId} AND t.is_template = TRUE
         WHERE c.workspace_id = ${workspaceId}
           AND (c.source IS DISTINCT FROM 'demo')
           AND c.created_at > NOW() - (${LOOKBACK_DAYS} || ' days')::interval
           AND d.status IN ('sent', 'completed')
           AND COALESCE(d.sent_at, d.created_at) BETWEEN c.created_at
                                          AND c.created_at + (${WINDOW_HOURS} || ' hours')::interval
         GROUP BY d.template_id
         ORDER BY n DESC
         LIMIT 1`;
      const templateId = tmpl.rows[0]?.id || null;
      if (templateId) {
        actions.push({ type: 'send_document', config: { templateId } });
      } else {
        actions.push({
          type: 'create_task',
          config: { title: 'Send {{clientName}} your usual document', dueInDays: 1 },
        });
      }
    }

    const signature = `client_created:${sigParts.join('+')}`;
    if (dismissed.includes(signature)) return null;

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
  } catch {
    // A suggestion is a nicety — never break the dashboard over it.
    return null;
  }
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
