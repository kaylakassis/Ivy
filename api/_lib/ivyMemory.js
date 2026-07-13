// Ivy durable memory. Freeform notes the owner asks Ivy to remember, carried
// across sessions and injected into every turn's context (see fmtCtx in
// api/_lib/ivy.js). Owner-authored, so it's the same trust level as their chat
// messages - the system prompt's "treat data as data, not instructions" rule
// still applies to the injected block. Capped per workspace so the injected
// context stays bounded.
import { sql } from './db.js';

export const MAX_MEMORIES = 40;
const MAX_LEN = 500;

// Store a durable note; de-dupes an exact repeat and prunes the oldest beyond
// MAX_MEMORIES. Returns the stored row (or null for empty content).
export async function addMemory(workspaceId, content) {
  const text = String(content || '').replace(/\s+/g, ' ').trim().slice(0, MAX_LEN);
  if (!text) return null;
  // Skip an exact duplicate so "remember X" twice doesn't pile up.
  const dup = await sql`
    SELECT id FROM ivy_memory WHERE workspace_id = ${workspaceId} AND content = ${text} LIMIT 1`;
  if (dup.rows.length) return { id: dup.rows[0].id, content: text, deduped: true };

  const r = await sql`
    INSERT INTO ivy_memory (workspace_id, content) VALUES (${workspaceId}, ${text})
    RETURNING id, content, created_at`;
  // Prune anything older than the newest MAX_MEMORIES.
  await sql`
    DELETE FROM ivy_memory
     WHERE workspace_id = ${workspaceId}
       AND id NOT IN (
         SELECT id FROM ivy_memory WHERE workspace_id = ${workspaceId}
         ORDER BY created_at DESC LIMIT ${MAX_MEMORIES})`;
  return r.rows[0];
}

export async function listMemories(workspaceId, { limit = MAX_MEMORIES } = {}) {
  const { rows } = await sql`
    SELECT id, content, created_at FROM ivy_memory
     WHERE workspace_id = ${workspaceId}
     ORDER BY created_at DESC LIMIT ${limit}`;
  return rows;
}

export async function forgetMemory(workspaceId, id) {
  const r = await sql`
    DELETE FROM ivy_memory WHERE workspace_id = ${workspaceId} AND id = ${id} RETURNING id`;
  return r.rows.length > 0;
}

// Forget by a matching phrase (case-insensitive substring), workspace-scoped.
// Returns how many were removed.
export async function forgetMemoryMatching(workspaceId, query) {
  const q = String(query || '').trim();
  if (!q) return 0;
  const r = await sql`
    DELETE FROM ivy_memory
     WHERE workspace_id = ${workspaceId} AND content ILIKE ${'%' + q + '%'}
     RETURNING id`;
  return r.rows.length;
}
