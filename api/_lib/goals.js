// Shared serializers + helpers for tasks and goals.
import { sql } from './db.js';

export const VALID_TASK_TYPES = new Set(['generic', 'message-client', 'send-invoice', 'send-document']);
export const VALID_GOAL_TYPES = new Set(['revenue', 'clients', 'sessions', 'custom']);

export function serializeTask(row) {
  if (!row) return null;
  return {
    id:            row.id,
    title:         row.title,
    type:          row.type,
    clientId:      row.client_id,
    done:          row.done,
    completedAt:   row.completed_at,
    completedAuto: row.completed_auto,
    dueDate:       row.due_date instanceof Date ? row.due_date.toISOString().slice(0, 10) : row.due_date,
    notes:         row.notes,
    source:        row.source,
    createdAt:     row.created_at,
    updatedAt:     row.updated_at,
  };
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

  if (type === 'revenue') {
    const { rows } = await sql`
      SELECT COALESCE(SUM(
        GREATEST(
          (SELECT COALESCE(SUM((it->>'quantity')::numeric * (it->>'rate')::numeric), 0)
            FROM jsonb_array_elements(items) AS it) - discount,
          0
        ) * (1 + tax_rate / 100)
      ), 0)::numeric AS total
      FROM invoices
      WHERE workspace_id = ${workspaceId}
        AND status = 'paid'
        AND paid_at >= date_trunc('month', NOW())
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
        AND date >= date_trunc('month', NOW())::date
        AND date <  (date_trunc('month', NOW()) + INTERVAL '1 month')::date
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
