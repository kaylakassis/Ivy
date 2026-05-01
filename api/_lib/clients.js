// Shared serializer + helpers for the clients table.
import { sql } from './db.js';

export function serializeClient(row) {
  if (!row) return null;
  return {
    id:            row.id,
    name:          row.name,
    email:         row.email,
    stage:         row.stage,
    tags:          row.tags || [],
    notes:         row.notes,
    lifetimeValue: Number(row.lifetime_value || 0),
    source:        row.source,
    referredByClientId: row.referred_by_client_id,
    joinedAt:      row.joined_at,
    lastSeenAt:    row.last_seen_at,
    createdAt:     row.created_at,
    updatedAt:     row.updated_at,
  };
}

// Fetch a single client and verify it belongs to the given workspace.
// Returns the row or null.
export async function fetchOwnedClient({ id, workspaceId }) {
  if (!id) return null;
  const { rows } = await sql`
    SELECT * FROM clients WHERE id = ${id} AND workspace_id = ${workspaceId}
  `;
  return rows[0] || null;
}

export const VALID_STAGES = new Set(['lead', 'active', 'paused']);
