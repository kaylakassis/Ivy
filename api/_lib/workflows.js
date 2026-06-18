// Workflow runtime. Two entry points:
//
//   triggerWorkflow({ workspaceId, triggerType, client, context })
//     Fired inline from the endpoint that matches the trigger (e.g.
//     clients/index.js POST → 'client_created'). Looks up enabled
//     workflows of that type and runs them.
//
//   evaluateScheduledWorkflows({ workspaceId? })
//     Called by the daily workflow cron. Queries the DB for clients
//     that match `client_inactive` / `booking_completed` conditions
//     and fires the matching workflows.
//
// Actions are run sequentially. Per-action failure doesn't abort the
// run - the action_result records 'failed' and the workflow continues.
// Whole-run status is 'succeeded' (all ok), 'partial' (some failed),
// 'failed' (none succeeded), or 'skipped' (dedupe / no actions).
//
// Dedupe: a (workflow_id, client_id) tuple fires at most once per
// calendar day. Without this, a client created at 11:59pm and again
// at 12:01am would receive duplicate emails.
import { sql } from './db.js';
import { sendEmailToClient, emailShell } from './email.js';
import { fetchBranding } from './branding.js';
import { sendClientSms } from './sms.js';
import { appUrl } from './tokens.js';

const VALID_TRIGGERS = new Set(['lead_created', 'client_created', 'client_inactive', 'booking_completed']);
const VALID_ACTIONS  = new Set([
  'send_email', 'send_sms', 'create_task', 'send_document',
  'wait',           // pause N days/hours, resume from the next action via cron
  'if_has_tag',     // skip remaining actions if client.tags does NOT include cfg.tag
  'if_lacks_tag',   // skip remaining actions if client.tags DOES include cfg.tag
]);

export function validateWorkflowShape(body) {
  const name = (body.name || '').toString().trim();
  if (!name) throw new Error('Workflow name is required');
  if (name.length > 200) throw new Error('Workflow name too long');
  const triggerType = (body.triggerType || '').toString();
  if (!VALID_TRIGGERS.has(triggerType)) {
    throw new Error('Invalid trigger type');
  }
  const triggerConfig = body.triggerConfig && typeof body.triggerConfig === 'object'
    ? body.triggerConfig : {};
  if (triggerType === 'client_inactive' || triggerType === 'booking_completed') {
    const d = Number(triggerConfig.daysInactive ?? triggerConfig.daysAfter);
    if (!Number.isFinite(d) || d < 1 || d > 3650) {
      throw new Error('Trigger needs a daysInactive (or daysAfter) in [1, 3650]');
    }
  }
  const actions = Array.isArray(body.actions) ? body.actions : [];
  if (actions.length === 0) throw new Error('At least one action is required');
  if (actions.length > 20) throw new Error('No more than 20 actions per workflow');
  const cleanedActions = actions.map((a, i) => {
    if (!a || typeof a !== 'object') throw new Error(`Action ${i + 1} is malformed`);
    if (!VALID_ACTIONS.has(a.type)) throw new Error(`Action ${i + 1}: unknown type "${a.type}"`);
    const cfg = a.config && typeof a.config === 'object' ? a.config : {};
    if (a.type === 'send_email') {
      const subj = String(cfg.subject || '').trim();
      const body = String(cfg.body || '').trim();
      if (!subj) throw new Error(`Action ${i + 1}: email subject is required`);
      if (!body) throw new Error(`Action ${i + 1}: email body is required`);
    }
    if (a.type === 'send_sms') {
      const body = String(cfg.body || '').trim();
      if (!body) throw new Error(`Action ${i + 1}: SMS body is required`);
    }
    if (a.type === 'create_task') {
      const title = String(cfg.title || '').trim();
      if (!title) throw new Error(`Action ${i + 1}: task title is required`);
    }
    if (a.type === 'send_document') {
      if (!cfg.templateId) throw new Error(`Action ${i + 1}: pick a document template`);
    }
    if (a.type === 'wait') {
      const d = Number(cfg.days || 0);
      const h = Number(cfg.hours || 0);
      if (!Number.isFinite(d) || !Number.isFinite(h) || d < 0 || h < 0) {
        throw new Error(`Action ${i + 1}: wait needs days + hours (non-negative numbers)`);
      }
      if (d === 0 && h === 0) {
        throw new Error(`Action ${i + 1}: wait must be at least 1 hour`);
      }
      if (d > 365) throw new Error(`Action ${i + 1}: wait can't exceed 365 days`);
    }
    if (a.type === 'if_has_tag' || a.type === 'if_lacks_tag') {
      const tag = String(cfg.tag || '').trim();
      if (!tag) throw new Error(`Action ${i + 1}: condition needs a tag`);
    }
    return { type: a.type, config: cfg };
  });
  return {
    name,
    description: body.description ? String(body.description).slice(0, 1000) : null,
    triggerType,
    triggerConfig,
    actions: cleanedActions,
    enabled: body.enabled == null ? true : !!body.enabled,
  };
}

// Resolves {{token}} placeholders in subject/body strings. Tokens we
// support today: firstName, clientName, businessName, ownerName.
function renderTokens(s, ctx) {
  if (!s) return s;
  return String(s).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => {
    const v = ctx[key];
    return v == null ? '' : String(v);
  });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Public entry point. workspaceId is required; client is the row that
// caused the trigger (with name/email/phone/id/sms_consent_at). The
// optional context bag is logged on workflow_runs for diagnosis.
export async function triggerWorkflow({ workspaceId, triggerType, client, context = {} }) {
  if (!workspaceId || !triggerType) return { fired: 0 };
  if (!VALID_TRIGGERS.has(triggerType)) return { fired: 0 };

  const { rows: workflows } = await sql`
    SELECT * FROM workflows
     WHERE workspace_id = ${workspaceId}
       AND trigger_type = ${triggerType}
       AND enabled = TRUE
     ORDER BY created_at ASC
  `;
  if (workflows.length === 0) return { fired: 0 };

  let fired = 0;
  for (const wf of workflows) {
    // eslint-disable-next-line no-await-in-loop
    const out = await runWorkflow({ workflow: wf, client, context });
    if (out.status !== 'skipped') fired++;
  }
  return { fired };
}

// Executes one workflow for one client. Handles dedupe + per-action
// error trapping + insert of the workflow_runs audit row.
//
// startIndex defaults to 0 - when a workflow resumes after a `wait`
// action, the cron passes the index of the next action to execute.
// isResume tells us to skip the same-day dedupe check (a wait that
// crosses midnight would otherwise re-trigger dedupe).
async function runWorkflow({ workflow, client, context = {}, startIndex = 0, isResume = false }) {
  // Dedupe: skip if this workflow already fired for this client today.
  // Resumed runs bypass dedupe - they're the SAME logical run, just
  // continuing across a wait boundary.
  //
  // Both casts MUST go through UTC so this query uses the
  // idx_workflow_runs_dedupe partial index defined in schema.js - the
  // index is built on `(triggered_at AT TIME ZONE 'UTC')::date`, so
  // a session-tz `triggered_at::date` cast would (a) miss the index
  // and (b) potentially disagree with the index on what "today"
  // means around midnight UTC.
  if (client?.id && !isResume) {
    // Booking-tied triggers dedupe per BOOKING + OCCURRENCE: a recurring
    // series fires the workflow once per completed occurrence (a given
    // single booking still fires at most once). Other triggers keep the
    // per-client-per-UTC-day guard (which uses idx_workflow_runs_dedupe).
    //
    // The `OR occurrenceDate IS NULL` clause treats a legacy run row
    // (written before per-occurrence keying) as already-fired for that
    // booking, so deploying this can't re-fire a booking that already ran.
    const occ = context?.occurrenceDate != null ? String(context.occurrenceDate) : null;
    const dup = context?.bookingId
      ? await sql`
          SELECT id FROM workflow_runs
           WHERE workflow_id = ${workflow.id}
             AND context->>'bookingId' = ${String(context.bookingId)}
             AND (context->>'occurrenceDate' = ${occ}
                  OR context->>'occurrenceDate' IS NULL)
           LIMIT 1
        `
      : await sql`
          SELECT id FROM workflow_runs
           WHERE workflow_id = ${workflow.id}
             AND client_id = ${client.id}
             AND (triggered_at AT TIME ZONE 'UTC')::date
                 = (NOW() AT TIME ZONE 'UTC')::date
           LIMIT 1
        `;
    if (dup.rows.length > 0) {
      return { status: 'skipped' };
    }
  }

  // Build the token bag once per run.
  const branding = await fetchBranding(workflow.workspace_id).catch(() => ({}));
  const ownerName = branding.ownerName || '';
  const businessName = branding.businessName || 'Your business';
  const firstName = (client?.name || '').split(/\s+/)[0] || 'there';
  const tokens = {
    firstName,
    clientName:   client?.name || 'there',
    businessName,
    ownerName,
  };

  const actions = Array.isArray(workflow.actions) ? workflow.actions : [];
  const results = [];
  let okCount = 0, failCount = 0;
  let waited = false;
  let conditionFailed = false;

  // i starts at startIndex so resumed runs pick up where the prior
  // wave left off. Each iteration either: (a) hits a wait → persists
  // a pending row and breaks; (b) hits a failing condition → skips the
  // rest; (c) executes the action.
  for (let i = startIndex; i < actions.length; i++) {
    const a = actions[i];

    // wait: persist a pending row and stop. The cron resumes from i+1.
    if (a.type === 'wait') {
      const cfg = a.config || {};
      const days = Number(cfg.days || 0);
      const hours = Number(cfg.hours || 0);
      const intervalSql = `${days} days ${hours} hours`;
      await sql`
        INSERT INTO workflow_pending_runs (
          workflow_id, workspace_id, client_id, client_snapshot,
          next_action_index, resume_at, context
        ) VALUES (
          ${workflow.id}, ${workflow.workspace_id}, ${client?.id || null},
          ${JSON.stringify({
            id: client?.id || null,
            name: client?.name || null,
            email: client?.email || null,
            phone: client?.phone || null,
            sms_consent_at: client?.sms_consent_at || null,
            tags: client?.tags || [],
          })}::jsonb,
          ${i + 1},
          NOW() + ${intervalSql}::interval,
          ${JSON.stringify(context)}::jsonb
        )
      `;
      results.push({ type: 'wait', status: 'queued', days, hours });
      waited = true;
      break;
    }

    // if_has_tag / if_lacks_tag: gate the rest of the workflow on a
    // client.tag check. Tags are case-insensitive matched.
    if (a.type === 'if_has_tag' || a.type === 'if_lacks_tag') {
      const targetTag = String(a.config?.tag || '').toLowerCase();
      const tags = Array.isArray(client?.tags) ? client.tags.map((t) => String(t).toLowerCase()) : [];
      const has = tags.includes(targetTag);
      const passes = a.type === 'if_has_tag' ? has : !has;
      results.push({ type: a.type, status: passes ? 'pass' : 'stop', tag: targetTag, has });
      if (!passes) {
        conditionFailed = true;
        break;
      }
      continue;
    }

    // Regular action - execute, capture pass/fail, continue loop.
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await executeAction({
        action: a, workflow, client, tokens, branding,
      });
      results.push({ type: a.type, status: 'ok', ...r });
      okCount++;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[workflow ${workflow.id}] action ${a.type} failed:`, err.message);
      results.push({ type: a.type, status: 'failed', error: err.message });
      failCount++;
    }
  }

  let status;
  if (waited) status = 'waiting';
  else if (conditionFailed && okCount === 0 && failCount === 0) status = 'stopped';
  else if (okCount === 0 && failCount === 0) status = 'skipped';
  else if (failCount === 0) status = 'succeeded';
  else if (okCount === 0)   status = 'failed';
  else                      status = 'partial';

  await sql`
    INSERT INTO workflow_runs (
      workflow_id, workspace_id, client_id, status, action_results, context
    ) VALUES (
      ${workflow.id}, ${workflow.workspace_id}, ${client?.id || null},
      ${status},
      ${JSON.stringify(results)}::jsonb,
      ${JSON.stringify(context)}::jsonb
    )
  `;
  await sql`
    UPDATE workflows SET last_run_at = NOW(), updated_at = NOW()
     WHERE id = ${workflow.id}
  `;

  return { status, results };
}

async function executeAction({ action, workflow, client, tokens, branding }) {
  const cfg = action.config || {};

  if (action.type === 'send_email') {
    if (!client?.email) {
      throw new Error('Client has no email on file');
    }
    const subject = renderTokens(cfg.subject, tokens);
    const bodyText = renderTokens(cfg.body, tokens);
    const html = emailShell({
      heading: cfg.heading ? renderTokens(cfg.heading, tokens) : subject,
      body: `<p>${escapeHtml(bodyText).replace(/\n\n+/g, '</p><p>').replace(/\n/g, '<br/>')}</p>`,
      ctaText: cfg.ctaText ? renderTokens(cfg.ctaText, tokens) : null,
      ctaUrl: cfg.ctaUrl ? renderTokens(cfg.ctaUrl, tokens) : null,
      footer: `Sent by ${escapeHtml(tokens.businessName)} via Ivy OS.`,
      branding,
    });
    // Workflow emails default to the `marketing` opt-out bucket since
    // they're owner-defined automations. (Future: let workflows specify
    // a per-action category in cfg.notifyType.)
    await sendEmailToClient({
      clientId: client.id,
      type: 'marketing',
      to: client.email,
      subject,
      html,
      replyTo: branding.replyTo,
    });
    return { to: client.email };
  }

  if (action.type === 'send_sms') {
    if (!client?.phone) throw new Error('Client has no phone on file');
    if (!client?.sms_consent_at) throw new Error('Client has not opted in to SMS');
    const body = renderTokens(cfg.body, tokens);
    const out = await sendClientSms({
      phone: client.phone, consentAt: client.sms_consent_at, body,
      workspaceId: workflow.workspace_id,
      // Workflow SMS is marketing-class (nurture / win-back / drip)
      // - gate to 8am-9pm in the workspace's IANA timezone. The cron
      // will retry on its next pass; this isn't ideal exactness (a
      // send queued at 7:55am workspace-local for a workflow that
      // ran at 7am will sit until 8am next-pass) but it keeps us
      // inside TCPA / carrier quiet-hours rules.
      respectQuietHours: true,
    });
    if (!out.ok) {
      if (out.reason === 'quiet-hours') {
        // Don't treat a quiet-hours skip as a failure; the workflow
        // action just no-ops for now and the next cron tick during
        // daylight will retry. (For one-shot workflow runs after a
        // trigger fires once, this means quiet-hour triggers
        // currently skip the SMS - acceptable for nurture cadence.)
        return { to: client.phone, skipped: 'quiet-hours' };
      }
      throw new Error(out.reason || 'SMS send failed');
    }
    return { to: client.phone };
  }

  if (action.type === 'create_task') {
    const title = renderTokens(cfg.title, tokens);
    const notes = renderTokens(cfg.notes || '', tokens);
    const dueDays = Number(cfg.dueInDays);
    if (Number.isFinite(dueDays) && dueDays > 0) {
      await sql`
        INSERT INTO tasks (workspace_id, title, notes, due_date, client_id, source)
        VALUES (
          ${workflow.workspace_id}, ${title}, ${notes || null},
          (CURRENT_DATE + (${dueDays}::int || ' days')::interval)::date,
          ${client?.id || null}, 'workflow'
        )
      `;
    } else {
      await sql`
        INSERT INTO tasks (workspace_id, title, notes, due_date, client_id, source)
        VALUES (
          ${workflow.workspace_id}, ${title}, ${notes || null}, NULL,
          ${client?.id || null}, 'workflow'
        )
      `;
    }
    return { title };
  }

  if (action.type === 'send_document') {
    const tmplId = cfg.templateId;
    if (!tmplId) throw new Error('No document template selected');
    // Pull the template, clone its content into a new document for this
    // client, set status='draft'. Owner approves + sends from /documents
    // (we don't auto-fire the send email - that's another action the
    // owner can add explicitly with send_email after this).
    //
    // documents columns: name, kind, content_html, file_url, fields,
    // recipient_*. We copy whichever content shape the template uses
    // (written → content_html; pdf → file_url) so both template kinds
    // round-trip cleanly.
    const tmpl = await sql`
      SELECT name, kind, content_html, file_url, fields
        FROM documents
       WHERE id = ${tmplId}
         AND workspace_id = ${workflow.workspace_id}
         AND is_template = TRUE
    `;
    if (tmpl.rows.length === 0) throw new Error('Template not found');
    const t = tmpl.rows[0];
    const ins = await sql`
      INSERT INTO documents (
        workspace_id, name, kind, content_html, file_url, fields, status,
        recipient_client_id, recipient_email, recipient_name,
        is_template
      ) VALUES (
        ${workflow.workspace_id},
        ${renderTokens(t.name, tokens) + ' - ' + (client?.name || '')},
        ${t.kind || 'written'},
        ${t.content_html || null},
        ${t.file_url || null},
        ${JSON.stringify(t.fields || [])}::jsonb,
        'draft',
        ${client?.id || null},
        ${client?.email || null},
        ${client?.name || null},
        FALSE
      )
      RETURNING id
    `;
    return { documentId: ins.rows[0].id };
  }

  throw new Error('Unknown action type: ' + action.type);
}

// Cron entry point. Walks every workspace's enabled scheduled workflows
// (client_inactive, booking_completed) and fires them for matching
// clients. Called daily from api/cron/workflows.js.
//
// To keep this from running off the rails, we cap to 500 fires per
// invocation. Real-world workspaces won't hit that.
// Resume any waiting workflows whose resume_at has passed. Called by
// the workflows cron alongside evaluateScheduledWorkflows. Each pending
// row resumes execution from next_action_index against the captured
// client_snapshot (not the live client row - see schema comment).
export async function resumeWaitingWorkflows({ limit = 200 } = {}) {
  const { rows: pending } = await sql`
    SELECT p.*, w.* FROM workflow_pending_runs p
    JOIN workflows w ON w.id = p.workflow_id
    WHERE p.resume_at <= NOW()
      AND w.enabled = TRUE
    ORDER BY p.resume_at ASC
    LIMIT ${Math.max(1, Math.min(500, limit))}
  `;
  let resumed = 0;
  for (const row of pending) {
    // The JOIN aliased some columns - rebuild the workflow object
    // from the row. workflows columns: id, workspace_id, name, ...,
    // actions, trigger_type, etc.
    const workflow = {
      id:             row.workflow_id,
      workspace_id:   row.workspace_id,
      name:           row.name,
      trigger_type:   row.trigger_type,
      trigger_config: row.trigger_config,
      actions:        row.actions,
      enabled:        row.enabled,
    };
    const client = row.client_snapshot || {};
    try {
      // eslint-disable-next-line no-await-in-loop
      await runWorkflow({
        workflow,
        client,
        context: row.context || {},
        startIndex: row.next_action_index || 0,
        isResume: true,
      });
      // eslint-disable-next-line no-await-in-loop
      await sql`DELETE FROM workflow_pending_runs WHERE id = ${row.id}`;
      resumed++;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[resumeWaitingWorkflows] pending=${row.id} failed:`, err.message);
      // Leave the row in place; next cron pass retries. Auto-prune
      // happens below at the end of every run.
    }
  }

  // Auto-prune pending rows that have been stuck for >7 days. These
  // are workflows that hit a permanent error (deleted action template,
  // missing recipient, etc.) and would otherwise re-fail forever every
  // cron tick. The owner can rebuild a fresh workflow if they care.
  // Logs a count so a sudden spike is visible in operational logs.
  try {
    const pruned = await sql`
      DELETE FROM workflow_pending_runs
      WHERE resume_at <= NOW() - INTERVAL '7 days'
      RETURNING id
    `;
    if (pruned.rows.length > 0) {
      console.warn(`[resumeWaitingWorkflows] pruned ${pruned.rows.length} stale pending runs (>7d)`);
    }
  } catch (pruneErr) {
    console.error('[resumeWaitingWorkflows] prune failed:', pruneErr.message);
  }

  return { resumed };
}

export async function evaluateScheduledWorkflows({ limit = 500 } = {}) {
  const { rows: workflows } = await sql`
    SELECT * FROM workflows
     WHERE enabled = TRUE
       AND trigger_type IN ('client_inactive', 'booking_completed')
     ORDER BY created_at ASC
  `;
  let total = 0;
  for (const wf of workflows) {
    if (total >= limit) break;
    // eslint-disable-next-line no-await-in-loop
    const fired = await evaluateScheduledForWorkflow(wf, limit - total);
    total += fired;
  }
  return { fired: total };
}

async function evaluateScheduledForWorkflow(wf, remaining) {
  const cfg = wf.trigger_config || {};
  const days = Number(cfg.daysInactive ?? cfg.daysAfter ?? 30);

  if (wf.trigger_type === 'client_inactive') {
    // Active clients whose most-recent non-cancelled booking is older
    // than N days. Excludes leads (they never had a "last booking" to
    // be inactive from). One row per matching client.
    const { rows: clients } = await sql`
      SELECT c.*, MAX(b.date) AS last_booking
        FROM clients c
        LEFT JOIN bookings b
          ON b.client_id = c.id AND b.cancelled_at IS NULL
       WHERE c.workspace_id = ${wf.workspace_id}
         AND c.stage = 'active'
       GROUP BY c.id
       HAVING MAX(b.date) IS NOT NULL
          AND MAX(b.date) <= CURRENT_DATE - (${days}::int || ' days')::interval
       LIMIT ${Math.max(1, Math.min(100, remaining))}
    `;
    return runWithConcurrency(clients, 10, async (c) => {
      const out = await runWorkflow({
        workflow: wf, client: c,
        context: { lastBooking: c.last_booking, daysInactive: days },
      });
      return out.status !== 'skipped' ? 1 : 0;
    });
  }

  if (wf.trigger_type === 'booking_completed') {
    // Bookings with an occurrence COMPLETED exactly N days ago. We key on
    // the completion_log entry for the target date - NOT b.date - so a
    // recurring series fires per completed occurrence. The old
    // `b.date = target AND completion_log ? b.date` form only ever matched
    // the series' first occurrence, so weekly clients never got their
    // "after each session" follow-up. completion_log keys are validated
    // YYYY-MM-DD on write, so ::text/::date casts are safe. Dedup is per
    // (booking, occurrence) in runWorkflow.
    const { rows: bookings } = await sql`
      SELECT b.*, c.id AS c_id, c.name AS c_name, c.email AS c_email,
             c.phone AS c_phone, c.sms_consent_at AS c_sms_consent_at,
             (CURRENT_DATE - (${days}::int || ' days')::interval)::date::text AS occurrence_date
        FROM bookings b
        LEFT JOIN clients c ON c.id = b.client_id
       WHERE b.workspace_id = ${wf.workspace_id}
         AND b.cancelled_at IS NULL
         AND b.no_show_at IS NULL
         AND jsonb_exists(
               b.completion_log,
               (CURRENT_DATE - (${days}::int || ' days')::interval)::date::text
             )
       LIMIT ${Math.max(1, Math.min(100, remaining))}
    `;
    return runWithConcurrency(bookings, 10, async (b) => {
      const client = {
        id: b.c_id, name: b.c_name, email: b.c_email,
        phone: b.c_phone, sms_consent_at: b.c_sms_consent_at,
      };
      const out = await runWorkflow({
        workflow: wf, client,
        context: {
          bookingId: b.id,
          bookingDate: b.occurrence_date,
          occurrenceDate: b.occurrence_date,
          daysAfter: days,
        },
      });
      return out.status !== 'skipped' ? 1 : 0;
    });
  }

  return 0;
}

// Run `fn(item)` over `items` with at most `concurrency` in flight at
// a time. Returns the total of all numeric resolves (used here to
// count "fired" actions). Failures inside `fn` are swallowed and
// counted as zero - workflows should not abort each other.
//
// Concurrency = 10 is a sweet spot for our load: it gives ~10x the
// throughput of serial without hitting Resend's 2 req/sec free-tier
// burst limit (most workflow actions are 1 email + 1 DB write per
// client; the email send dominates and Resend itself queues bursts).
async function runWithConcurrency(items, concurrency, fn) {
  let cursor = 0;
  let total = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        total += (await fn(items[i])) || 0;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[workflows] item failed:', err.message);
      }
    }
  });
  await Promise.all(workers);
  return total;
}

export function serializeWorkflow(row, lastRunSummary) {
  if (!row) return null;
  return {
    id:             row.id,
    name:           row.name,
    description:    row.description || null,
    triggerType:    row.trigger_type,
    triggerConfig:  row.trigger_config || {},
    actions:        Array.isArray(row.actions) ? row.actions : [],
    enabled:        !!row.enabled,
    lastRunAt:      row.last_run_at,
    lastRunSummary: lastRunSummary || null,
    createdAt:      row.created_at,
    updatedAt:      row.updated_at,
  };
}
