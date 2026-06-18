// POST /api/clients/import - bulk-create clients from a parsed CSV.
// Body: { rows: [{ name, email?, stage?, notes?, source?, tags? }, ...] }
// Behavior:
//   • De-dupes by email within the workspace. Existing rows are SKIPPED
//     (not updated) so import can never silently mutate hand-curated data.
//   • Without an email, every row is treated as a new client (no dedupe).
//   • Returns a summary: { created, skipped, invalid, errors[] }.
//
// All inserts are scoped to the authenticated user's workspace - nothing
// in the request body can override that.
import { sql } from '../_lib/db.js';
import { requireUser, validEmail } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { VALID_STAGES, serializeClient } from '../_lib/clients.js';
import { sendClientInvite } from '../_lib/clientNotify.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

const MAX_ROWS = 2000;
const NAME_MAX = 120;
const NOTES_MAX = 4000;

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
    const body = await readBody(req);
    if (!Array.isArray(body.rows)) return badRequest(res, 'rows[] is required');
    if (body.rows.length === 0) return badRequest(res, 'No rows to import');
    if (body.rows.length > MAX_ROWS) {
      return badRequest(res, `Too many rows - split into batches of ${MAX_ROWS}`);
    }

    // Pre-fetch existing emails in this workspace so the dedupe check is
    // O(N) instead of O(N) round-trips. Lower-cased for case-insensitive
    // match - same convention the auth code uses.
    const existing = await sql`
      SELECT LOWER(email) AS email FROM clients
      WHERE workspace_id = ${workspaceId} AND email IS NOT NULL
    `;
    const existingEmails = new Set(existing.rows.map((r) => r.email));

    let created = 0;
    let skipped = 0;
    let invalid = 0;
    const errors = [];
    const inserted = [];

    // Validate + dedupe in memory (no per-row DB round trips), collecting the
    // survivors. The actual inserts happen in batches below.
    const toInsert = [];
    for (let i = 0; i < body.rows.length; i++) {
      const r = body.rows[i] || {};
      const name = (r.name || '').toString().trim();
      const emailRaw = (r.email || '').toString().trim();
      const email = emailRaw ? emailRaw.toLowerCase() : null;
      const stage = VALID_STAGES.has(r.stage) ? r.stage : 'lead';
      const source = r.source ? String(r.source).slice(0, 60) : 'CSV import';
      const notes = r.notes ? String(r.notes).slice(0, NOTES_MAX) : null;
      const tags = Array.isArray(r.tags)
        ? r.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 20)
        : [];

      if (!name || name.length > NAME_MAX) {
        invalid++;
        errors.push({ row: i + 1, error: 'Name is required (max 120 chars)' });
        continue;
      }
      if (email && !validEmail(email)) {
        invalid++;
        errors.push({ row: i + 1, error: `Invalid email: ${emailRaw}` });
        continue;
      }
      if (email && existingEmails.has(email)) {
        skipped++;
        continue;
      }
      if (email) existingEmails.add(email); // prevent duplicate within same batch
      toInsert.push({ name, email, stage, tags, notes, source });
    }

    // Bulk-insert in chunks: one multi-row INSERT per chunk instead of one
    // round trip per row. A 2,000-row CSV used to mean 2,000 serial Neon
    // HTTP calls (function-timeout territory during bulk onboarding); now
    // it's ~4 round trips. Chunked so the parameter count per statement
    // stays well under Postgres's 65,535 limit (500 rows * 7 cols = 3,500).
    const CHUNK = 500;
    for (let c = 0; c < toInsert.length; c += CHUNK) {
      const chunk = toInsert.slice(c, c + CHUNK);
      const valuesSql = [];
      const params = [];
      let p = 0;
      for (const row of chunk) {
        valuesSql.push(`($${++p}, $${++p}, $${++p}, $${++p}, $${++p}::text[], $${++p}, $${++p})`);
        params.push(workspaceId, row.name, row.email, row.stage, row.tags, row.notes, row.source);
      }
      const text = `
        INSERT INTO clients (workspace_id, name, email, stage, tags, notes, source)
        VALUES ${valuesSql.join(', ')}
        RETURNING *
      `;
      try {
        // eslint-disable-next-line no-await-in-loop
        const result = await sql.query(text, params);
        created += result.rows.length;
        for (const cr of result.rows) {
          if (inserted.length < 50) inserted.push(serializeClient(cr));
          // Fire invite email - best-effort, idempotent via invite_sent_at.
          if (cr.email) {
            sendClientInvite({ workspaceId, clientId: cr.id })
              .catch((e) => console.error('[import] sendClientInvite failed:', e?.message));
          }
        }
      } catch (err) {
        // A chunk failure shouldn't sink the whole import.
        invalid += chunk.length;
        errors.push({ row: `${c + 1}-${c + chunk.length}`, error: err.message?.slice(0, 200) || 'Bulk insert failed' });
      }
    }

    return ok(res, {
      summary: { created, skipped, invalid, total: body.rows.length },
      errors: errors.slice(0, 50), // cap so the response stays small
      inserted, // first 50 fully serialized, for optimistic UI
    });
  } catch (err) {
    return serverError(res, err);
  }
}
