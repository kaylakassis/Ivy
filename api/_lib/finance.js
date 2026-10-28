// Shared serializers + helpers for invoices.
import { sql } from './db.js';

export const VALID_STATUS = new Set(['draft', 'sent', 'paid', 'overdue', 'voided', 'refunded']);
export const VALID_PAID_METHOD = new Set(['card', 'ach', 'cash', 'check', 'transfer', 'zelle', 'venmo', 'cashapp', 'other']);

// Human labels for paid_method values. Receipts, activity rows and the
// owner's "says paid" banner all read from here so "cashapp" never leaks
// into copy a client sees.
export const PAID_METHOD_LABELS = {
  card: 'card', ach: 'ACH', cash: 'cash', check: 'check', transfer: 'bank transfer',
  zelle: 'Zelle', venmo: 'Venmo', cashapp: 'Cash App', paypal: 'PayPal', other: 'other',
};
export function paidMethodLabel(method) {
  return PAID_METHOD_LABELS[method] || (method ? String(method) : 'other');
}

// Ways to get paid that no processor handles at checkout. The owner lists
// them under Finance > Other ways to get paid; the public invoice page
// shows the enabled ones. 'other' covers anything we did not think of.
export const MANUAL_METHOD_TYPES = new Set(['zelle', 'venmo', 'cashapp', 'cash', 'check', 'other']);
export const MANUAL_METHOD_LABELS = {
  zelle: 'Zelle', venmo: 'Venmo', cashapp: 'Cash App', cash: 'Cash', check: 'Check', other: 'Other',
};
export const MANUAL_METHODS_MAX = 6;
const HANDLE_MAX = 120;
const NOTE_MAX = 300;
// These need something to send to; cash and check do not.
const HANDLE_REQUIRED = new Set(['zelle', 'venmo', 'cashapp']);

// Validates + normalizes the owner's manual-methods list. Returns the
// cleaned array or throws an Error with a message safe to show the owner.
export function normalizeManualMethods(input) {
  if (!Array.isArray(input)) throw new Error('methods must be a list');
  if (input.length > MANUAL_METHODS_MAX) throw new Error(`You can list up to ${MANUAL_METHODS_MAX} ways to get paid`);
  const out = [];
  const seen = new Set();
  for (const raw of input) {
    const m = raw && typeof raw === 'object' ? raw : {};
    const type = String(m.type || '').toLowerCase().trim();
    if (!MANUAL_METHOD_TYPES.has(type)) throw new Error(`Unknown payment method "${type || '?'}"`);
    if (seen.has(type) && type !== 'other') throw new Error(`${MANUAL_METHOD_LABELS[type]} is listed twice`);
    seen.add(type);
    const handle = String(m.handle ?? '').trim();
    const note   = String(m.note ?? '').trim();
    if (handle.length > HANDLE_MAX) throw new Error(`${MANUAL_METHOD_LABELS[type]} handle must be ${HANDLE_MAX} characters or fewer`);
    if (note.length > NOTE_MAX) throw new Error(`${MANUAL_METHOD_LABELS[type]} note must be ${NOTE_MAX} characters or fewer`);
    const enabled = m.enabled === true || m.enabled === 'true';
    if (enabled && HANDLE_REQUIRED.has(type) && !handle) {
      throw new Error(`Add where clients should send ${MANUAL_METHOD_LABELS[type]} payments, or turn it off`);
    }
    out.push({ type, handle, note, enabled });
  }
  return out;
}

// Enabled manual methods for a workspace, shaped for the public invoice
// page: [{ type, handle, note }]. Empty when none are set up.
export async function fetchEnabledManualMethods(workspaceId) {
  const r = await sql`SELECT manual_methods FROM finance_settings WHERE workspace_id = ${workspaceId}`;
  const list = Array.isArray(r.rows[0]?.manual_methods) ? r.rows[0].manual_methods : [];
  return list
    .filter((m) => m && m.enabled && MANUAL_METHOD_TYPES.has(m.type))
    .map((m) => ({ type: m.type, handle: String(m.handle || ''), note: String(m.note || '') }));
}

// Generalized finance_settings fetcher used by the multi-provider
// payments layer. Returns a normalized object (or null when no row
// exists yet); never throws on a missing connection - that's a
// caller-side decision now that more than one processor exists.
export async function fetchFinanceSettings(workspaceId) {
  const r = await sql`
    SELECT * FROM finance_settings WHERE workspace_id = ${workspaceId}
  `;
  const row = r.rows[0];
  if (!row) return null;
  return {
    workspaceId:                  row.workspace_id,
    paymentProvider:              row.payment_provider || 'stripe',
    currency:                     (row.currency || 'USD').toUpperCase(),
    // Stripe (Connect)
    stripeConnectUserId:          row.stripe_connect_user_id || null,
    stripeConnectLivemode:        row.stripe_connect_livemode,
    stripeOnboardingStatus:       row.stripe_onboarding_status || null,
    stripeAccountLabel:           row.stripe_account_label || null,
    stripeConnectedAt:            row.stripe_connected_at || null,
    stripeSecretEncrypted:        row.stripe_secret_encrypted || null,
    stripeWebhookSecretEncrypted: row.stripe_webhook_secret_encrypted || null,
    // Stripe Tax (opt-in, configured per workspace).
    stripeTaxEnabled:             !!row.stripe_tax_enabled,
    stripeTaxBehavior:            row.stripe_tax_behavior || null,
    // Square
    squareCredentialsEncrypted:   row.square_credentials_encrypted || null,
    squareMerchantId:             row.square_merchant_id || null,
    squareLocationId:             row.square_location_id || null,
    squareAccountLabel:           row.square_account_label || null,
    squareConnectedAt:            row.square_connected_at || null,
    squareEnvironment:            row.square_environment || null,
    // PayPal Commerce
    paypalMerchantId:             row.paypal_merchant_id || null,
    paypalAccountLabel:           row.paypal_account_label || null,
    paypalConnectedAt:            row.paypal_connected_at || null,
    paypalPaymentsEnabled:        !!row.paypal_payments_enabled,
    paypalEnvironment:            row.paypal_environment || null,
    // Manual (off-platform) ways to get paid.
    manualMethods:                Array.isArray(row.manual_methods) ? row.manual_methods : [],
  };
}

// Round to 2dp (avoid float-drift on totals).
const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;

export function computeTotals(items, taxRate, discount) {
  const subtotal = (items || []).reduce(
    (s, it) => s + Number(it.quantity || 0) * Number(it.rate || 0),
    0,
  );
  const taxable = Math.max(0, subtotal - Number(discount || 0));
  const tax = taxable * (Number(taxRate || 0) / 100);
  const total = taxable + tax;
  return { subtotal: round2(subtotal), tax: round2(tax), total: round2(total) };
}

export function serializeInvoice(row) {
  if (!row) return null;
  const items = row.items || [];
  const taxRate = Number(row.tax_rate || 0);
  const discount = Number(row.discount || 0);
  const totals = computeTotals(items, taxRate, discount);
  return {
    id:           row.id,
    number:       row.number,
    clientId:     row.client_id,
    clientName:   row.client_name,
    clientEmail:  row.client_email,
    issueDate:    row.issue_date instanceof Date ? row.issue_date.toISOString().slice(0, 10) : row.issue_date,
    dueDate:      row.due_date   instanceof Date ? row.due_date.toISOString().slice(0, 10)   : row.due_date,
    items,
    taxRate,
    discount,
    // Currency code (ISO 4217). Defaults to USD on legacy rows that
    // were written before the column existed.
    currency:     row.currency || 'USD',
    notes:        row.notes,
    status:       row.status,
    sentAt:       row.sent_at,
    paidAt:       row.paid_at,
    paidMethod:   row.paid_method,
    refundedAmount: Number(row.refunded_amount || 0),
    paidAmount:     row.paid_amount == null ? null : Number(row.paid_amount),
    refundedAt:   row.refunded_at,
    stripePaymentIntent: row.stripe_payment_intent || null,
    // "Client says they paid" - cleared by clear-claim, left in place on
    // confirm so the history of how it was settled survives.
    paymentClaimedAt:     row.payment_claimed_at || null,
    paymentClaimedMethod: row.payment_claimed_method || null,
    paymentClaimedNote:   row.payment_claimed_note || null,
    // Delayed-settlement payment (ACH Direct Debit) authorised but not yet
    // cleared. The invoice stays unpaid; the UI shows "Payment processing".
    paymentProcessingAt:     row.payment_processing_at || null,
    paymentProcessingMethod: row.payment_processing_method || null,
    activity:     row.activity || [],
    subtotal:     totals.subtotal,
    tax:          totals.tax,
    total:        totals.total,
    createdAt:    row.created_at,
    updatedAt:    row.updated_at,
  };
}

// Public-facing serializer (no workspace ids, no internal flags, no view token).
export function serializeInvoicePublic(row, workspaceMeta = {}) {
  if (!row) return null;
  const inv = serializeInvoice(row);
  delete inv.id; // public viewer references by token, not raw id
  delete inv.paymentClaimedNote; // the client's own note - no need to echo it
  const unpaid = row.status === 'sent' || row.status === 'overdue';
  return {
    ...inv,
    business: workspaceMeta.business || null,
    paymentEnabled: !!workspaceMeta.paymentEnabled,
    // Other ways to pay - only while there is something left to pay.
    manualMethods: unpaid && Array.isArray(workspaceMeta.manualMethods) ? workspaceMeta.manualMethods : [],
    // Saved card for repeat invoices from THIS business: display fragments
    // only (brand/last4), never Stripe ids. canSaveCard = the client may
    // tick "save this card" on a card checkout.
    savedCard: workspaceMeta.savedCard || null,
    canSaveCard: !!workspaceMeta.canSaveCard,
  };
}

export async function fetchOwnedInvoice({ id, workspaceId }) {
  if (!id) return null;
  const { rows } = await sql`
    SELECT * FROM invoices WHERE id = ${id} AND workspace_id = ${workspaceId}
  `;
  return rows[0] || null;
}

export function cleanItems(input) {
  if (!Array.isArray(input)) return null;
  if (input.length > 100) return null;
  const out = [];
  for (let i = 0; i < input.length; i++) {
    const it = input[i] || {};
    const desc = (it.description || '').toString().slice(0, 500);
    const qty  = Number(it.quantity ?? 1);
    const rate = Number(it.rate ?? 0);
    if (!Number.isFinite(qty) || qty < 0)  return null;
    if (!Number.isFinite(rate) || rate < 0) return null;
    out.push({
      id: it.id || `li_${Math.random().toString(36).slice(2, 8)}`,
      // POS lines carry the source product so void/restore can restock;
      // survive owner edits rather than being silently stripped.
      ...(it.productId ? { productId: String(it.productId).slice(0, 64) } : {}),
      description: desc,
      quantity: Math.round(qty * 1000) / 1000,
      rate: Math.round(rate * 100) / 100,
    });
  }
  return out;
}

// Create a DRAFT invoice for a client — the single source of truth used by the
// Ivy create_invoice tool AND the create_invoice workflow action. Mints the
// number the canonical way (`INV-<n>`), sanitizes items, inherits the workspace
// default tax rate when none is given, and leaves it as a draft (never sends).
// The invoices_compute_total trigger fills in `total`.
export async function createDraftInvoice({
  workspaceId, clientId = null, clientName = null, clientEmail = null,
  items, taxRate = null, discount = 0, notes = null, dueInDays = 14,
}) {
  const cleaned = cleanItems(items);
  // cleanItems returns null for structurally invalid input - guard both
  // shapes or a bad workflow payload TypeErrors on null.length.
  if (!cleaned || cleaned.length === 0) throw new Error('At least one valid line item is required');
  let tax = taxRate == null ? null : Number(taxRate);
  if (tax == null || !Number.isFinite(tax)) {
    const r = await sql`SELECT default_tax_rate FROM finance_settings WHERE workspace_id = ${workspaceId}`;
    tax = Number(r.rows[0]?.default_tax_rate || 0);
  }
  const num = await nextInvoiceNumber(workspaceId);
  const number = `INV-${num}`;
  const issueDate = new Date().toISOString().slice(0, 10);
  const d = Number(dueInDays);
  const due = new Date();
  due.setDate(due.getDate() + (Number.isFinite(d) && d >= 0 ? d : 14));
  const dueDate = due.toISOString().slice(0, 10);
  const { rows } = await sql`
    INSERT INTO invoices (
      workspace_id, number, client_id, client_name, client_email,
      issue_date, due_date, items, tax_rate, discount, notes, status
    ) VALUES (
      ${workspaceId}, ${number}, ${clientId}, ${clientName}, ${clientEmail},
      ${issueDate}, ${dueDate}, ${JSON.stringify(cleaned)}::jsonb, ${tax},
      ${Number(discount) || 0}, ${notes ? String(notes).slice(0, 4000) : null}, 'draft'
    )
    RETURNING id, number
  `;
  return rows[0];
}

// Allocate the next invoice number for this workspace, atomically.
export async function nextInvoiceNumber(workspaceId) {
  // Ensure a settings row exists.
  await sql`
    INSERT INTO finance_settings (workspace_id) VALUES (${workspaceId})
    ON CONFLICT (workspace_id) DO NOTHING
  `;
  const r = await sql`
    UPDATE finance_settings
    SET next_invoice_number = next_invoice_number + 1
    WHERE workspace_id = ${workspaceId}
    RETURNING next_invoice_number
  `;
  // The returned value is the NEW counter; the issued number is the old one.
  return r.rows[0].next_invoice_number - 1;
}
