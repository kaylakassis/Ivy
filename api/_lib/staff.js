// Shared serializer for staff_members. Used by /api/staff endpoints.
import { sql } from './db.js';

export function serializeStaff(row) {
  if (!row) return null;
  return {
    id:             row.id,
    name:           row.name,
    email:          row.email || null,
    phone:          row.phone || null,
    role:           row.role || null,
    color:          row.color || null,
    hourlyRate:     row.hourly_rate == null ? null : Number(row.hourly_rate),
    commissionRate: row.commission_rate == null ? null : Number(row.commission_rate),
    active:         !!row.active,
    ownerManaged:   row.owner_managed !== false,
    userId:         row.user_id || null,
    createdAt:      row.created_at,
    updatedAt:      row.updated_at,
  };
}

export async function fetchOwnedStaff({ id, workspaceId }) {
  if (!id) return null;
  const r = await sql`
    SELECT * FROM staff_members
     WHERE id = ${id} AND workspace_id = ${workspaceId}
  `;
  return r.rows[0] || null;
}
