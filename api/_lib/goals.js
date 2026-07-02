// Shared serializers + helpers for tasks and goals.
import { sql } from './db.js';
import { workspaceTimeZone } from './calendar.js';

export const VALID_TASK_TYPES = new Set(['generic', 'message-client', 'send-invoice', 'send-document']);
export const VALID_GOAL_TYPES = new Set(['revenue', 'clients', 'sessions', 'custom']);

export function serializeTask(row) {
  if (!row) return null;
  // `progress` arrives from TASK_SELECT_WITH_PROGRESS as 0 or 100.
  // For inserts that don't go through that select, fall back to the binary
  // "done" state so the field is always present client-side.
  const progress = row.progress != null ? Number(row.progress) : (row.done ? 100 : 0);
  return {
    id:            row.id,
    title:         row.title,
    type:          row.type,
    clientId:      row.client_id,
    done:          row.done,
    completedAt:   row.completed_at,
    completedAuto: row.completed_auto,
    progress,
    dueDate:       row.due_date instanceof Date ? row.due_date.toISOString().slice(0, 10) : row.due_date,
    notes:         row.notes,
    source:        row.source,
    createdAt:     row.created_at,
    updatedAt:     row.updated_at,
  };
}

// Smart-task progress: 100 when the corresponding app activity exists,
// 0 otherwise. The client uses this to glow rows that are "ready to mark done"
// without waiting for the user to remember to tick them off.
export const TASK_SELECT_WITH_PROGRESS = `
  SELECT t.*,
    CASE
      WHEN t.done THEN 100
      WHEN t.type = 'message-client' AND t.client_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM message_threads mt
        JOIN messages m ON m.thread_id = mt.id
        WHERE mt.workspace_id = t.workspace_id
          AND mt.client_id = t.client_id
          AND m.sender = 'biz'
          AND m.created_at >= t.created_at
      ) THEN 100
      WHEN t.type = 'send-invoice' AND t.client_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM invoices i
        WHERE i.workspace_id = t.workspace_id
          AND i.client_id = t.client_id
          AND i.status <> 'draft'
          AND i.sent_at >= t.created_at
      ) THEN 100
      WHEN t.type = 'send-document' AND t.client_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM documents d
        WHERE d.workspace_id = t.workspace_id
          AND d.recipient_client_id = t.client_id
          AND d.sent_at >= t.created_at
      ) THEN 100
      ELSE 0
    END::int AS progress
  FROM tasks t
`;

export async function listTasksWithProgress(workspaceId, filter) {
  let queryText;
  if (filter === 'true') {
    queryText = `${TASK_SELECT_WITH_PROGRESS}
      WHERE t.workspace_id = $1 AND t.done = TRUE
      ORDER BY t.completed_at DESC NULLS LAST`;
  } else if (filter === 'false') {
    queryText = `${TASK_SELECT_WITH_PROGRESS}
      WHERE t.workspace_id = $1 AND t.done = FALSE
      ORDER BY t.due_date NULLS LAST, t.created_at`;
  } else {
    queryText = `${TASK_SELECT_WITH_PROGRESS}
      WHERE t.workspace_id = $1
      ORDER BY t.done, t.due_date NULLS LAST, t.created_at`;
  }
  const { rows } = await sql.query(queryText, [workspaceId]);
  return rows;
}

export async function fetchOwnedTaskWithProgress({ id, workspaceId }) {
  if (!id) return null;
  const queryText = `${TASK_SELECT_WITH_PROGRESS}
    WHERE t.id = $1 AND t.workspace_id = $2`;
  const { rows } = await sql.query(queryText, [id, workspaceId]);
  return rows[0] || null;
}

export function serializeGoal(row, current) {
  if (!row) return null;
  return {
    id:            row.id,
    title:         row.title,
    type:          row.type,
    target:        Number(row.target || 0),
    current:       Number(current ?? row.current_manual ?? 0),
    deadline:      row.deadline instanceof Date ? row.deadline.toISOString().slice(0, 10) : row.deadline,
    notes:         row.notes,
    createdAt:     row.created_at,
    updatedAt:     row.updated_at,
  };
}

// Compute the "current" value for each goal type using the workspace's other data.
//   revenue: sum of paid invoices this month
//   clients: count of active clients
//   sessions: count of non-cancelled bookings this month
//   custom: stored as goals.current_manual
export async function computeGoalCurrent(workspaceId, type) {
  if (type === 'custom') return null; // caller falls back to current_manual

  // "This month" is the owner's calendar month in their timezone, so a goal's
  // progress matches what the dashboard shows.
  const tz = await workspaceTimeZone(workspaceId);

  if (type === 'revenue') {
    // Read the materialized invoices.total column - the SAME source the
    // finance dashboard uses (api/finance/index.js, switched in cae9800).
    // Previously this re-derived the total from the items JSONB, which
    // rounded differently than the column and made the goal's "current"
    // disagree with the dashboard by a few cents ("$0.04 off on another
    // tab"). One source of truth keeps every surface consistent.
    const { rows } = await sql`
      SELECT COALESCE(SUM(total - COALESCE(refunded_amount, 0)), 0)::numeric AS total
      FROM invoices
      WHERE workspace_id = ${workspaceId}
        AND status = 'paid'
        AND paid_at >= date_trunc('month', NOW() AT TIME ZONE ${tz}) AT TIME ZONE ${tz}
    `;
    return Number(rows[0].total || 0);
  }

  if (type === 'clients') {
    const { rows } = await sql`
      SELECT COUNT(*)::int AS n FROM clients
      WHERE workspace_id = ${workspaceId} AND stage = 'active'
    `;
    return Number(rows[0].n || 0);
  }

  if (type === 'sessions') {
    const { rows } = await sql`
      SELECT COUNT(*)::int AS n FROM bookings
      WHERE workspace_id = ${workspaceId}
        AND cancelled_at IS NULL
        AND date >= (date_trunc('month', NOW() AT TIME ZONE ${tz}))::date
        AND date <  (date_trunc('month', NOW() AT TIME ZONE ${tz}) + INTERVAL '1 month')::date
    `;
    return Number(rows[0].n || 0);
  }

  return 0;
}

export async function fetchOwnedTask({ id, workspaceId }) {
  if (!id) return null;
  const { rows } = await sql`SELECT * FROM tasks WHERE id = ${id} AND workspace_id = ${workspaceId}`;
  return rows[0] || null;
}
export async function fetchOwnedGoal({ id, workspaceId }) {
  if (!id) return null;
  const { rows } = await sql`SELECT * FROM goals WHERE id = ${id} AND workspace_id = ${workspaceId}`;
  return rows[0] || null;
}

// Auto-complete "smart" tasks whose triggering activity has happened.
// The UI shows these at progress=100 with an "auto" badge (see
// TASK_SELECT_WITH_PROGRESS), but nothing ever actually marked them done -
// so the badge was unreachable and owners still ticked every one by hand.
// Run from the workflows cron. One set-based UPDATE across all workspaces;
// mirrors the exact progress=100 conditions. Returns the count flipped.
export async function autoCompleteSmartTasks() {
  const { rowCount } = await sql`
    UPDATE tasks t
       SET done = TRUE, completed_auto = TRUE,
           completed_at = NOW(), updated_at = NOW()
     WHERE t.done = FALSE
       AND t.client_id IS NOT NULL
       AND (
         (t.type = 'message-client' AND EXISTS (
           SELECT 1 FROM message_threads mt
             JOIN messages m ON m.thread_id = mt.id
            WHERE mt.workspace_id = t.workspace_id AND mt.client_id = t.client_id
              AND m.sender = 'biz' AND m.created_at >= t.created_at))
         OR (t.type = 'send-invoice' AND EXISTS (
           SELECT 1 FROM invoices i
            WHERE i.workspace_id = t.workspace_id AND i.client_id = t.client_id
              AND i.status <> 'draft' AND i.sent_at >= t.created_at))
         OR (t.type = 'send-document' AND EXISTS (
           SELECT 1 FROM documents d
            WHERE d.workspace_id = t.workspace_id AND d.recipient_client_id = t.client_id
              AND d.sent_at >= t.created_at))
       )
  `;
  return rowCount || 0;
}
