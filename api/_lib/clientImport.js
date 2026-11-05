// Shared bulk client import: the CSV importer (POST /api/clients/import) and
// Ivy's import_clients_from_list tool both go through here, so the two can
// never drift on validation, dedupe or what gets sent.
//
//   prepareClientImport(workspaceId, rows, opts) → plan (no writes)
//   insertPreparedClients(workspaceId, plan, opts) → inserts + side effects
//
// Dedupe, within the workspace: by email first (case-insensitive), then by
// normalized phone. A phone match is a duplicate unless both records carry
// different emails (two people sharing a household phone). Rows that repeat
// inside the same upload are deduped the same way. Existing clients are
// SKIPPED, never updated, so an import can never silently change data the
// owner curated by hand.
//
// Rows may also carry the richer record (addressParts, birthday, pronouns,
// emergencyContact, preferredContact, occupation) and customFields keyed by
// a field id, or by a `ref` from opts.fieldRefs (fields the CSV importer
// just created from unmapped columns). A value that does not fit (a bad
// birthday, "maybe" in a yes/no field) never loses the person: it is kept
// in their notes as written.
//
// Quiet imports (opts.quiet) send nothing at all: no portal invites, no
// client_created / lead_created automations. Moving a whole book into Ivy
// must not look like "new leads arriving" to anyone.
import { sql } from './db.js';
import { validEmail } from './auth.js';
import { VALID_STAGES, serializeClient } from './clients.js';
import { normalizePhone } from './sms.js';
import { sendClientInvite } from './clientNotify.js';
import { fireClientCreatedWorkflows, hasClientCreatedWorkflows } from './workflows.js';
import { clientDetailColumns, mergeCustomFields, DETAIL_COLUMNS } from './clientDetails.js';

export const CLIENT_IMPORT_MAX_ROWS = 2000;
const NAME_MAX = 120;
const NOTES_MAX = 4000;
const PHONE_RAW_MAX = 40;
// client_created / lead_created workflows fire per imported row up to this
// many new clients. Past it the import is a book migration, not "new leads
// arriving" (auto-emailing 2,000 historical contacts from a welcome workflow
// would be a disaster), so we skip and say so in the response.
export const WORKFLOW_FIRE_MAX = 200;
const CHUNK = 500;

function digitsKey(phone) {
  return phone ? String(phone).replace(/\D/g, '') : '';
}

// Loads the workspace's existing emails + phones once, so dedupe is O(N)
// with no per-row round trips.
async function loadExisting(workspaceId) {
  const r = await sql`
    SELECT id, name, LOWER(email) AS email, phone FROM clients
     WHERE workspace_id = ${workspaceId}
       AND ((email IS NOT NULL AND email <> '') OR (phone IS NOT NULL AND phone <> ''))
  `;
  const byEmail = new Map();
  const byPhone = new Map();
  for (const row of r.rows) {
    if (row.email) byEmail.set(row.email, row);
    const norm = normalizePhone(row.phone);
    const key = digitsKey(norm || row.phone);
    if (key && !byPhone.has(key)) byPhone.set(key, row);
  }
  return { byEmail, byPhone };
}

// Validates + dedupes. Never writes.
//   opts.onBadPhone: 'reject' (row is invalid, like a bad email; the CSV
//     importer) or 'note' (keep the person, put the number as written into
//     notes; Ivy reading a photo, where a smudged digit must not lose them).
//   opts.defaultSource: clients.source when the row gives none.
//   opts.fieldDefs: the business's custom field definitions (for
//     customFields); opts.fieldRefs: Map(ref → definition).
// Returns { toInsert, duplicates: [{ index, name, reason, existingName }],
//           invalid: [{ index, error }], total }.
export async function prepareClientImport(workspaceId, rows, opts = {}) {
  const onBadPhone = opts.onBadPhone === 'note' ? 'note' : 'reject';
  const defaultSource = opts.defaultSource || 'CSV import';
  const { byEmail, byPhone } = await loadExisting(workspaceId);
  const fieldDefs = Array.isArray(opts.fieldDefs) ? opts.fieldDefs : [];
  const fieldRefs = opts.fieldRefs instanceof Map ? opts.fieldRefs : new Map();
  const toInsert = [];
  const duplicates = [];
  const invalid = [];
  const list = Array.isArray(rows) ? rows : [];
  for (let i = 0; i < list.length; i++) {
    const r = list[i] && typeof list[i] === 'object' ? list[i] : {};
    const name = (r.name ?? '').toString().trim();
    const emailRaw = (r.email ?? '').toString().trim();
    const email = emailRaw ? emailRaw.toLowerCase() : null;
    const stage = VALID_STAGES.has(r.stage) ? r.stage : (opts.defaultStage || 'lead');
    const source = r.source ? String(r.source).slice(0, 60) : defaultSource;
    let notes = r.notes ? String(r.notes).slice(0, NOTES_MAX) : null;
    const tags = Array.isArray(r.tags)
      ? r.tags.map((t) => String(t).trim().slice(0, 60)).filter(Boolean).slice(0, 20)
      : [];

    // The richer record. Lenient: a value that does not fit is kept in
    // notes as written rather than failing the row.
    const det = clientDetailColumns(r, { lenient: true });
    let custom = {};
    const extraNotes = [...det.asWritten];
    if (r.customFields && typeof r.customFields === 'object' && fieldDefs.length) {
      const keyed = {};
      for (const [k, v] of Object.entries(r.customFields).slice(0, 60)) {
        const def = fieldRefs.get(k);
        keyed[def ? def.id : k] = v;
      }
      const m = mergeCustomFields({}, keyed, fieldDefs, { lenient: true });
      if (m.errors.length) extraNotes.push('Some custom field values were too long to keep');
      else custom = m.values;
      extraNotes.push(...m.asWritten);
    }
    if (extraNotes.length) notes = (notes ? `${notes}\n${extraNotes.join('\n')}` : extraNotes.join('\n')).slice(0, NOTES_MAX);

    if (!name || name.length > NAME_MAX) {
      invalid.push({ index: i, error: `Name is required (max ${NAME_MAX} chars)` });
      continue;
    }
    if (email && (email.length > 254 || !validEmail(email))) {
      invalid.push({ index: i, error: `Invalid email: ${emailRaw.slice(0, 120)}` });
      continue;
    }
    let phone = null;
    const phoneRaw = r.phone == null ? '' : String(r.phone).trim().slice(0, PHONE_RAW_MAX);
    if (phoneRaw) {
      phone = normalizePhone(phoneRaw);
      if (!phone) {
        if (onBadPhone === 'reject') {
          invalid.push({ index: i, error: `Invalid phone: ${phoneRaw}` });
          continue;
        }
        const line = `Phone as written: ${phoneRaw}`;
        notes = notes ? `${notes}\n${line}`.slice(0, NOTES_MAX) : line;
      }
    }

    if (email && byEmail.has(email)) {
      duplicates.push({ index: i, name, reason: 'email', existingName: byEmail.get(email).name });
      continue;
    }
    const pKey = digitsKey(phone);
    if (pKey && byPhone.has(pKey)) {
      const ex = byPhone.get(pKey);
      if (!(email && ex.email && ex.email !== email)) {
        duplicates.push({ index: i, name, reason: 'phone', existingName: ex.name });
        continue;
      }
    }
    // Later rows in the same upload dedupe against this one.
    const marker = { name, email, phone };
    if (email) byEmail.set(email, marker);
    if (pKey && !byPhone.has(pKey)) byPhone.set(pKey, marker);
    toInsert.push({ index: i, name, email, phone, stage, tags, notes, source, details: det.cols, custom });
  }
  return { toInsert, duplicates, invalid, total: list.length };
}

// Inserts the planned rows in chunks (one multi-row INSERT per 500 rows, so a
// 2,000-row import is ~4 round trips). Side effects:
//   opts.quiet === true  → nothing is sent and no automation fires.
//   otherwise            → invites only when opts.sendInvites === true;
//                          client_created / lead_created workflows fire per
//                          new client up to WORKFLOW_FIRE_MAX.
// Returns { created, invalid, errors, inserted (first 50 serialized),
//           importedIds (row order), createdRows, workflowsFired, workflowsSkipped }.
export async function insertPreparedClients(workspaceId, plan, opts = {}) {
  const quiet = opts.quiet === true;
  let created = 0;
  let invalid = 0;
  const errors = [];
  const inserted = [];
  const importedIds = [];
  const createdRows = [];
  const toInsert = plan.toInsert || [];

  for (let c = 0; c < toInsert.length; c += CHUNK) {
    const chunk = toInsert.slice(c, c + CHUNK);
    const valuesSql = [];
    const params = [];
    let p = 0;
    for (const row of chunk) {
      const ph = [`$${++p}`, `$${++p}`, `$${++p}`, `$${++p}`, `$${++p}`, `$${++p}::text[]`, `$${++p}`, `$${++p}`];
      params.push(workspaceId, row.name, row.email, row.phone, row.stage, row.tags, row.notes, row.source);
      // Detail columns come from a fixed allow-list, never from the request.
      const d = row.details || {};
      for (const col of DETAIL_COLUMNS) { ph.push(`$${++p}`); params.push(d[col] === undefined ? null : d[col]); }
      ph.push(`$${++p}::jsonb`);
      params.push(JSON.stringify(row.custom || {}));
      valuesSql.push(`(${ph.join(', ')})`);
    }
    const text = `
      INSERT INTO clients (workspace_id, name, email, phone, stage, tags, notes, source, ${DETAIL_COLUMNS.join(', ')}, custom_fields)
      VALUES ${valuesSql.join(', ')}
      RETURNING *
    `;
    try {
      const result = await sql.query(text, params);
      // importedIds follow upload order: match rows back explicitly rather
      // than trusting RETURNING order.
      const ordered = orderLikeChunk(chunk, result.rows);
      created += ordered.length;
      for (const cr of ordered) {
        importedIds.push(cr.id);
        if (inserted.length < 50) inserted.push(serializeClient(cr));
        createdRows.push(cr);
      }
    } catch (err) {
      // A chunk failure shouldn't sink the whole import.
      invalid += chunk.length;
      errors.push({ row: `${chunk[0].index + 1}-${chunk[chunk.length - 1].index + 1}`, error: err.message?.slice(0, 200) || 'Bulk insert failed' });
    }
  }

  let workflowsFired = 0;
  let workflowsSkipped = false;
  if (!quiet) {
    // Invite emails on bulk import are EXPLICIT OPT-IN (sendInvites === true).
    if (opts.sendInvites === true) {
      for (const cr of createdRows) {
        if (!cr.email) continue;
        sendClientInvite({ workspaceId, clientId: cr.id })
          .catch((e) => console.error('[import] sendClientInvite failed:', e?.message));
      }
    }
    // Workflows: one pre-check so a workspace with no client_created /
    // lead_created automations pays nothing; otherwise fire per new row
    // (sequential; the runtime dedupes per client per day). Skipped
    // wholesale above WORKFLOW_FIRE_MAX.
    if (createdRows.length > WORKFLOW_FIRE_MAX) {
      workflowsSkipped = true;
    } else if (createdRows.length > 0 && await hasClientCreatedWorkflows(workspaceId).catch(() => false)) {
      for (const cr of createdRows) {
        const out = await fireClientCreatedWorkflows({ workspaceId, client: cr, source: opts.workflowSource || 'csv-import' });
        workflowsFired += out.fired;
      }
    }
  }

  return { created, invalid, errors, inserted, importedIds, createdRows, workflowsFired, workflowsSkipped };
}

// Rows come back from one INSERT; put them in the chunk's order. Each
// planned row is matched to an unused returned row with the same name,
// email and phone (identical rows are interchangeable, so any match is right).
function orderLikeChunk(chunk, rows) {
  const pool = new Map();
  for (const r of rows) {
    const k = `${r.name}\u0000${r.email || ''}\u0000${r.phone || ''}`;
    if (!pool.has(k)) pool.set(k, []);
    pool.get(k).push(r);
  }
  const out = [];
  for (const planned of chunk) {
    const k = `${planned.name}\u0000${planned.email || ''}\u0000${planned.phone || ''}`;
    const bucket = pool.get(k);
    if (bucket && bucket.length) out.push(bucket.shift());
  }
  // Anything unmatched (should not happen) goes last rather than vanishing.
  for (const bucket of pool.values()) out.push(...bucket);
  return out;
}

export const CLIENT_IMPORT_WORKFLOW_SKIP_REASON = `Automations don't run for imports of more than ${WORKFLOW_FIRE_MAX} new clients`;
