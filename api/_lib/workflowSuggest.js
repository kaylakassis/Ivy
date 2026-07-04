// "Ivy noticed a pattern" — detects that an owner repeats the same manual
// follow-up after adding a client (e.g. always sends an invoice + a contract),
// and proposes a client_created workflow that automates it. Deterministic SQL
// over the domain tables (there's no event log) — joins the last N clients to
// the invoices/documents created within 48h of each, and fires when a strong
// majority match. Suppressed once an owner already has a client_created
// workflow, or once they dismiss the suggestion (signature stored in ui_prefs).
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
