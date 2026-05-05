// Helpers for recurring invoices: serialization, cadence math, and
// the materialization that the daily cron uses to mint new invoice
// rows.
import { sql } from './db.js';
import { computeTotals, cleanItems, nextInvoiceNumber } from './finance.js';

export const VALID_CADENCE = new Set(['weekly', 'biweekly', 'monthly', 'quarterly', 'yearly']);
export const VALID_STATUS  = new Set(['active', 'paused', 'ended']);

export function serializeRecurring(row) {
  if (!row) return null;
  const items = row.items || [];
  const taxRate  = Number(row.tax_rate || 0);
  const discount = Number(row.discount || 0);
  const totals = computeTotals(items, taxRate, discount);
  return {
    id:            row.id,
    name:          row.name,
    clientId:      row.client_id,
    clientName:    row.client_name,
    clientEmail:   row.client_email,
    items,
    taxRate,
    discount,
    notes:         row.notes,
    cadence:       row.cadence,
    nextRunAt:     toDateString(row.next_run_at),
    endDate:       toDateString(row.end_date),
    status:        row.status,
    autoSend:      !!row.auto_send,
    lastRunAt:     row.last_run_at,
    lastInvoiceId: row.last_invoice_id,
    occurrencesRun: row.occurrences_run,
    subtotal:      totals.subtotal,
    tax:           totals.tax,
    total:         totals.total,
    createdAt:     row.created_at,
    updatedAt:     row.updated_at,
  };
}

function toDateString(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'string') return v.slice(0, 10);
  return null;
}

// Advance a YYYY-MM-DD string by one cadence interval. Pure function
// — operates in UTC to dodge DST surprises around month boundaries.
export function advanceDate(dateStr, cadence) {
  const d = new Date(dateStr + 'T00:00:00Z');
  switch (cadence) {
    case 'weekly':    d.setUTCDate(d.getUTCDate() + 7); break;
    case 'biweekly':  d.setUTCDate(d.getUTCDate() + 14); break;
    case 'monthly':   d.setUTCMonth(d.getUTCMonth() + 1); break;
    case 'quarterly': d.setUTCMonth(d.getUTCMonth() + 3); break;
    case 'yearly':    d.setUTCFullYear(d.getUTCFullYear() + 1); break;
    default: break;
  }
  return d.toISOString().slice(0, 10);
}

// Caller-side validator for incoming POST/PATCH bodies. Returns
// { ok: true, sanitized } or { ok: false, error }.
export function cleanRecurringInput(body, { partial = false } = {}) {
  const out = {};

  if ('name' in body || !partial) {
    const v = (body.name || '').toString().trim();
    if (!v && !partial) return { ok: false, error: 'name is required' };
    if (v) {
      if (v.length > 200) return { ok: false, error: 'name too long' };
      out.name = v;
    }
  }
  if ('clientId' in body) {
    out.clientId = body.clientId ? String(body.clientId) : null;
  }
  if ('items' in body || !partial) {
    const items = cleanItems(body.items ?? []);
    if (items === null) return { ok: false, error: 'invalid items' };
    out.items = items;
  }
  if ('taxRate' in body) {
    const n = Number(body.taxRate);
    if (!Number.isFinite(n) || n < 0 || n > 100) return { ok: false, error: 'taxRate must be 0–100' };
    out.taxRate = n;
  }
  if ('discount' in body) {
    const n = Number(body.discount);
    if (!Number.isFinite(n) || n < 0) return { ok: false, error: 'discount must be non-negative' };
    out.discount = n;
  }
  if ('notes' in body) {
    out.notes = body.notes ? String(body.notes).slice(0, 4000) : null;
  }
  if ('cadence' in body || !partial) {
    const c = (body.cadence || '').toString();
    if (!VALID_CADENCE.has(c) && !partial) return { ok: false, error: 'cadence is required' };
    if (VALID_CADENCE.has(c)) out.cadence = c;
  }
  if ('nextRunAt' in body || 'startDate' in body || !partial) {
    const v = (body.nextRunAt || body.startDate || '').toString();
    if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return { ok: false, error: 'nextRunAt must be YYYY-MM-DD' };
    if (v) out.nextRunAt = v;
    else if (!partial) return { ok: false, error: 'startDate is required' };
  }
  if ('endDate' in body) {
    const v = (body.endDate || '').toString();
    if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return { ok: false, error: 'endDate must be YYYY-MM-DD' };
    out.endDate = v || null;
  }
  if ('status' in body) {
    const s = (body.status || '').toString();
    if (!VALID_STATUS.has(s)) return { ok: false, error: 'invalid status' };
    out.status = s;
  }
  if ('autoSend' in body) {
    out.autoSend = !!body.autoSend;
  }
  return { ok: true, sanitized: out };
}

// Materializes a single recurring schedule into a real invoice row.
// Caller is the cron (or a manual "Run now" button). Returns the
// new invoice row, or null if the schedule is no longer eligible
// (already past end_date, paused, etc.).
//
// On success, advances the schedule's next_run_at, stamps last_run_at
// and last_invoice_id, and bumps occurrences_run. The caller decides
// whether to also auto-send (see flags on the schedule row).
export async function materializeOne(scheduleId) {
  const r = await sql`SELECT * FROM recurring_invoices WHERE id = ${scheduleId}`;
  const s = r.rows[0];
  if (!s) return { skipped: true, reason: 'not-found' };
  if (s.status !== 'active') return { skipped: true, reason: 'not-active' };
  const today = new Date().toISOString().slice(0, 10);
  if (toDateString(s.next_run_at) > today) return { skipped: true, reason: 'not-due' };
  if (s.end_date && toDateString(s.end_date) < toDateString(s.next_run_at)) {
    await sql`UPDATE recurring_invoices SET status = 'ended', updated_at = NOW() WHERE id = ${scheduleId}`;
    return { skipped: true, reason: 'past-end' };
  }

  const num = await nextInvoiceNumber(s.workspace_id);
  const number = `INV-${num}`;

  const issueDate = toDateString(s.next_run_at);
  // Default due in 14 days from issue (matches the casual default
  // most service providers expect).
  const dueDate = addDays(issueDate, 14);

  const ins = await sql`
    INSERT INTO invoices (
      workspace_id, number, client_id, client_name, client_email,
      issue_date, due_date, items, tax_rate, discount, notes,
      status, activity
    ) VALUES (
      ${s.workspace_id}, ${number}, ${s.client_id}, ${s.client_name}, ${s.client_email},
      ${issueDate}, ${dueDate}, ${JSON.stringify(s.items || [])}::jsonb,
      ${s.tax_rate}, ${s.discount}, ${s.notes},
      'draft',
      ${JSON.stringify([{ ts: new Date().toISOString(), kind: 'auto-created', text: `Auto-created from recurring: ${s.name}` }])}::jsonb
    )
    RETURNING *
  `;
  const newInvoice = ins.rows[0];

  // Advance schedule.
  const newNext = advanceDate(toDateString(s.next_run_at), s.cadence);
  const overEnd = s.end_date && toDateString(s.end_date) < newNext;
  await sql`
    UPDATE recurring_invoices SET
      next_run_at      = ${newNext}::date,
      last_run_at      = NOW(),
      last_invoice_id  = ${newInvoice.id},
      occurrences_run  = occurrences_run + 1,
      status           = ${overEnd ? 'ended' : s.status},
      updated_at       = NOW()
    WHERE id = ${scheduleId}
  `;

  return { skipped: false, schedule: s, invoice: newInvoice };
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
