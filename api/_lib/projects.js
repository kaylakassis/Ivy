// Shared serializer + helpers for the projects table. Kept tiny — most
// of the read/write logic lives in the api/projects/* endpoints; this
// module just normalizes the row shape and centralizes the valid-status
// set so endpoints don't drift on enum values.
import { sql } from './db.js';

export const VALID_STATUS = new Set([
  'planning', 'active', 'on_hold', 'completed', 'cancelled',
]);

export function serializeProject(row, counts) {
  if (!row) return null;
  return {
    id:           row.id,
    clientId:     row.client_id || null,
    clientName:   row.client_name || null,  // joined via api/projects
    name:         row.name,
    description:  row.description || null,
    status:       row.status,
    color:        row.color || null,
    startsAt:     row.starts_at,
    endsAt:       row.ends_at,
    amountQuoted: row.amount_quoted == null ? null : Number(row.amount_quoted),
    notes:        row.notes || null,
    createdAt:    row.created_at,
    updatedAt:    row.updated_at,
    // counts is an optional { bookings, invoices, quotes, documents }
    // bag the index endpoint joins in so the UI can show "3 invoices,
    // 2 bookings" without a follow-up fetch.
    counts:       counts || null,
  };
}

export async function fetchOwnedProject({ id, workspaceId }) {
  if (!id) return null;
  const r = await sql`
    SELECT p.*, c.name AS client_name
      FROM projects p
      LEFT JOIN clients c ON c.id = p.client_id AND c.workspace_id = p.workspace_id
     WHERE p.id = ${id} AND p.workspace_id = ${workspaceId}
  `;
  return r.rows[0] || null;
}
