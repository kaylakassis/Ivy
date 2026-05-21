// Helpers for quotes. Mirrors the invoice helpers — line items use
// the same {id, description, quantity, rate} shape so accepting a
// quote can clone its items into a fresh invoice with no mapping.
import { sql } from './db.js';
import { computeTotals, cleanItems } from './finance.js';

export const VALID_STATUS = new Set(['draft', 'sent', 'accepted', 'declined', 'expired', 'voided']);

// Proposal items extend invoice items with client-selectable options:
//   optional      — an add-on the client can include/exclude
//   packageGroup  — a tier key; client picks exactly one item per group
//   selected      — current/default selection (required items are always in)
// isIncluded decides whether an item counts toward the total + is cloned
// into the invoice on accept.
export function isIncluded(it) {
  if (!it) return false;
  if (it.packageGroup) return it.selected === true;
  if (it.optional) return it.selected !== false;
  return true;
}

// Total over only the INCLUDED items (required + selected options).
export function quoteTotals(items, taxRate, discount) {
  return computeTotals((items || []).filter(isIncluded), taxRate, discount);
}

// Sanitize proposal line items: reuse cleanItems for the base shape, then
// preserve the option fields. A packageGroup implies optional.
export function cleanQuoteItems(input) {
  const base = cleanItems(input);
  if (base === null) return null;
  return base.map((it, i) => {
    const src = input[i] || {};
    const packageGroup = src.packageGroup ? String(src.packageGroup).slice(0, 60) : null;
    const optional = packageGroup ? true : !!src.optional;
    const selected = optional ? !!src.selected : true;
    return { ...it, optional, packageGroup, selected };
  });
}

export function serializeQuote(row) {
  if (!row) return null;
  const items = row.items || [];
  const taxRate = Number(row.tax_rate || 0);
  const discount = Number(row.discount || 0);
  const totals = quoteTotals(items, taxRate, discount);
  return {
    id:           row.id,
    number:       row.number,
    clientId:     row.client_id,
    clientName:   row.client_name,
    clientEmail:  row.client_email,
    issueDate:    row.issue_date instanceof Date ? row.issue_date.toISOString().slice(0, 10) : row.issue_date,
    expiryDate:   row.expiry_date instanceof Date ? row.expiry_date.toISOString().slice(0, 10) : row.expiry_date,
    items,
    hasOptions:   items.some((it) => it.optional || it.packageGroup),
    taxRate,
    discount,
    notes:        row.notes,
    status:       row.status,
    sentAt:       row.sent_at,
    acceptedAt:   row.accepted_at,
    declinedAt:   row.declined_at,
    declineReason: row.decline_reason || null,
    resultingInvoiceId: row.resulting_invoice_id || null,
    activity:     row.activity || [],
    subtotal:     totals.subtotal,
    tax:          totals.tax,
    total:        totals.total,
    createdAt:    row.created_at,
    updatedAt:    row.updated_at,
  };
}

// Public-facing serializer for the /quote/:token page. Strips id +
// internal flags and adds business identity for the page header.
export function serializeQuotePublic(row, workspaceMeta = {}) {
  if (!row) return null;
  const inv = serializeQuote(row);
  delete inv.id;
  return {
    ...inv,
    business: workspaceMeta.business || null,
  };
}

export async function fetchOwnedQuote({ id, workspaceId }) {
  if (!id) return null;
  const { rows } = await sql`
    SELECT * FROM quotes WHERE id = ${id} AND workspace_id = ${workspaceId}
  `;
  return rows[0] || null;
}

export { cleanItems };

// Allocate the next quote number for this workspace, atomically.
// Mirrors nextInvoiceNumber to keep the patterns consistent.
export async function nextQuoteNumber(workspaceId) {
  await sql`
    INSERT INTO finance_settings (workspace_id) VALUES (${workspaceId})
    ON CONFLICT (workspace_id) DO NOTHING
  `;
  const r = await sql`
    UPDATE finance_settings
    SET next_quote_number = next_quote_number + 1
    WHERE workspace_id = ${workspaceId}
    RETURNING next_quote_number
  `;
  return r.rows[0].next_quote_number - 1;
}
