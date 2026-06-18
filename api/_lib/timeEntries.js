// Helpers for time tracking entries.
import { sql } from './db.js';

export const VALID_STATUS = new Set(['running', 'stopped', 'billed']);

export function serializeEntry(row) {
  if (!row) return null;
  // Live duration for running entries - the UI animates a counter,
  // but this snapshot is enough for list rendering between renders.
  let seconds = row.duration_seconds;
  if (seconds == null && row.started_at && !row.ended_at) {
    const start = row.started_at instanceof Date ? row.started_at : new Date(row.started_at);
    seconds = Math.floor((Date.now() - start.getTime()) / 1000);
  }
  const hours = (seconds || 0) / 3600;
  const amount = Math.round(hours * Number(row.hourly_rate || 0) * 100) / 100;
  return {
    id:              row.id,
    clientId:        row.client_id,
    clientName:      row.client_name || null,
    serviceId:       row.service_id,
    serviceName:     row.service_name || null,
    description:     row.description || '',
    startedAt:       row.started_at,
    endedAt:         row.ended_at,
    durationSeconds: seconds,
    hourlyRate:      Number(row.hourly_rate || 0),
    billable:        !!row.billable,
    status:          row.status,
    invoiceId:       row.invoice_id,
    amount,
    createdAt:       row.created_at,
    updatedAt:       row.updated_at,
  };
}

// Pulls entries for a workspace + joins client/service names so the
// UI doesn't need a second round trip for display.
export async function listEntries({ workspaceId, status, clientId }) {
  let q;
  if (status && clientId) {
    q = sql`
      SELECT t.*, c.name AS client_name, s.name AS service_name
        FROM time_entries t
        LEFT JOIN clients c  ON c.id = t.client_id
        LEFT JOIN services s ON s.id = t.service_id
       WHERE t.workspace_id = ${workspaceId}
         AND t.status = ${status}
         AND t.client_id = ${clientId}
       ORDER BY t.started_at DESC
       LIMIT 500
    `;
  } else if (status) {
    q = sql`
      SELECT t.*, c.name AS client_name, s.name AS service_name
        FROM time_entries t
        LEFT JOIN clients c  ON c.id = t.client_id
        LEFT JOIN services s ON s.id = t.service_id
       WHERE t.workspace_id = ${workspaceId}
         AND t.status = ${status}
       ORDER BY t.started_at DESC
       LIMIT 500
    `;
  } else if (clientId) {
    q = sql`
      SELECT t.*, c.name AS client_name, s.name AS service_name
        FROM time_entries t
        LEFT JOIN clients c  ON c.id = t.client_id
        LEFT JOIN services s ON s.id = t.service_id
       WHERE t.workspace_id = ${workspaceId}
         AND t.client_id = ${clientId}
       ORDER BY t.started_at DESC
       LIMIT 500
    `;
  } else {
    q = sql`
      SELECT t.*, c.name AS client_name, s.name AS service_name
        FROM time_entries t
        LEFT JOIN clients c  ON c.id = t.client_id
        LEFT JOIN services s ON s.id = t.service_id
       WHERE t.workspace_id = ${workspaceId}
       ORDER BY t.started_at DESC
       LIMIT 500
    `;
  }
  const r = await q;
  return r.rows.map(serializeEntry);
}

export async function fetchOwnedEntry(id, workspaceId) {
  const r = await sql`
    SELECT t.*, c.name AS client_name, s.name AS service_name
      FROM time_entries t
      LEFT JOIN clients c  ON c.id = t.client_id
      LEFT JOIN services s ON s.id = t.service_id
     WHERE t.id = ${id} AND t.workspace_id = ${workspaceId}
     LIMIT 1
  `;
  return r.rows[0] || null;
}
