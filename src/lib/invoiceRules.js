// Invoice money and action rules, shared by the server (API gates, Ivy's
// tools, crons) and the browser (which buttons show, the status line).
// Pure: no database, no DOM. Accepts either a database row (snake_case) or
// a serialized invoice (camelCase).
//
// The accounting rules, in plain words:
//   Draft, never sent, nothing paid  -> can be deleted outright.
//   Sent / overdue, nothing paid     -> can be voided (kept on record,
//                                       marked Void, pay link stops taking
//                                       money, nothing owed). Not deleted:
//                                       the client has seen it.
//   Some money paid, not all         -> cannot be voided while that money
//                                       is held. Refund the payment, then
//                                       void.
//   Paid                             -> cannot be deleted or voided (money
//                                       moved; needed for records and
//                                       taxes). Refund it (full or part).
//   Refunded in full                 -> net $0, nothing owed. Kept on
//                                       record.
//   Paid, refunded, void             -> can be archived (hidden from the
//                                       main list, reversible, revenue
//                                       history unchanged).

const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;

function field(inv, camel, snake) {
  if (!inv) return undefined;
  return inv[camel] !== undefined ? inv[camel] : inv[snake];
}

function totalOf(inv) {
  const t = field(inv, 'total', 'total');
  if (t != null && t !== '') return Number(t);
  const items = Array.isArray(inv?.items) ? inv.items : [];
  const subtotal = items.reduce((s, it) => s + Number(it.quantity || 0) * Number(it.rate || 0), 0);
  const taxRate = Number(field(inv, 'taxRate', 'tax_rate') || 0);
  const taxable = Math.max(0, subtotal - Number(inv?.discount || 0));
  return r2(taxable + taxable * (taxRate / 100));
}

export const OPEN_STATUSES = new Set(['sent', 'overdue']);
export const CLOSED_STATUSES = new Set(['paid', 'refunded', 'voided']);

// The money on one invoice.
//   total     what the invoice is for
//   giftCard  gift card credit still applied (handed back on void/refund)
//   paid      money collected (what a refund can give back)
//   refunded  money given back
//   net       money kept: paid minus refunded
//   owed      what the client still has to pay (0 unless sent/overdue)
export function invoiceMoney(inv) {
  const status = field(inv, 'status', 'status');
  const total = r2(totalOf(inv));
  const giftCents = Number(field(inv, 'giftCardCreditCents', 'gift_card_credit_cents') || 0);
  const giftRestored = Number(field(inv, 'giftCardCreditRestoredCents', 'gift_card_credit_restored_cents') || 0);
  const giftCard = r2(Math.max(0, giftCents - giftRestored) / 100);
  const paidRaw = field(inv, 'paidAmount', 'paid_amount');
  const paidMethod = field(inv, 'paidMethod', 'paid_method');
  let paid;
  if (paidRaw != null && paidRaw !== '') paid = Number(paidRaw);
  else if (status === 'paid' || status === 'refunded') paid = Math.max(0, total - giftCents / 100);
  else paid = 0;
  paid = r2(paid);
  const refunded = r2(field(inv, 'refundedAmount', 'refunded_amount') || 0);
  const net = r2(Math.max(0, paid - refunded));
  // A gift-card-paid invoice records the card credit as its payment, so it
  // must not be subtracted twice.
  const giftCovers = paidMethod === 'gift_card' ? 0 : giftCard;
  const owed = OPEN_STATUSES.has(status) ? r2(Math.max(0, total - giftCovers - net)) : 0;
  const fullyRefunded = status === 'refunded' || (paid > 0 && refunded >= paid - 0.005);
  return { total, giftCard, paid, refunded, net, owed, fullyRefunded };
}

// Money the business still holds on an invoice that is not marked paid
// (a part payment). Voiding is blocked while this is above zero.
function heldOnOpen(inv) {
  const status = field(inv, 'status', 'status');
  if (status === 'paid' || status === 'refunded') return 0;
  return invoiceMoney(inv).net;
}

const fmt = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// What the owner can do with this invoice right now. Each entry is
// { ok: boolean, why?: string } where `why` is a plain sentence for the
// owner (or Ivy) explaining a refusal and the right alternative.
export function invoiceActions(inv) {
  const status = field(inv, 'status', 'status');
  const sentAt = field(inv, 'sentAt', 'sent_at');
  const archivedAt = field(inv, 'archivedAt', 'archived_at');
  const processing = !!field(inv, 'paymentProcessingAt', 'payment_processing_at');
  const m = invoiceMoney(inv);
  const held = heldOnOpen(inv);
  const giftHeld = m.giftCard > 0;
  const yes = { ok: true };
  const no = (why) => ({ ok: false, why });

  // ── delete ──
  let del;
  if (status === 'paid' || status === 'refunded') {
    del = no("Paid and refunded invoices can't be deleted because money moved. You can archive it to hide it.");
  } else if (status === 'sent' || status === 'overdue') {
    del = no('This invoice was already sent, so it stays on record. Void it instead.');
  } else if (sentAt) {
    del = status === 'voided'
      ? no('This invoice was sent before it was voided, so it stays on record. You can archive it to hide it.')
      : no('This invoice was sent before, so it stays on record. Void it instead.');
  } else if (m.paid > 0 || held > 0 || giftHeld) {
    del = no('This invoice has a payment or gift card on it, so it stays on record.');
  } else if (status === 'draft' || status === 'voided') {
    del = yes;
  } else {
    del = no("This invoice can't be deleted.");
  }

  // ── void ──
  let vd;
  if (status === 'voided') vd = no('This invoice is already void. Nothing is owed.');
  else if (status === 'refunded') vd = no("This invoice was refunded in full, so nothing is owed and there is nothing to void. You can archive it to hide it.");
  else if (status === 'paid') vd = no("A paid invoice can't be voided because money moved. Refund it instead; after that you can archive it.");
  else if (processing) vd = no('A bank payment for this invoice is on its way. Wait for it to clear, then refund it if needed.');
  else if (held > 0) vd = no(`${fmt(held)} has been paid on this invoice. Refund that payment first, then void it.`);
  else vd = yes;

  // ── refund ──
  let rf;
  if (status === 'refunded' || (m.paid > 0 && m.net <= 0)) rf = no('This invoice has already been refunded in full. Nothing is owed.');
  else if (status === 'voided') rf = no('This invoice is void and has no payment to refund.');
  else if (m.net > 0 && (status === 'paid' || OPEN_STATUSES.has(status))) rf = yes;
  else rf = no('Nothing has been paid on this invoice, so there is nothing to refund.' + (status === 'draft' ? ' You can delete the draft.' : ' Void it instead.'));

  // ── archive / unarchive ──
  let ar;
  if (archivedAt) ar = no('This invoice is already archived.');
  else if (CLOSED_STATUSES.has(status)) ar = yes;
  else if (status === 'draft') ar = no('Drafts are not archived. Delete the draft instead.');
  else ar = no('Open invoices are not archived while money is owed. Void it first if it is no longer owed.');
  const un = archivedAt ? yes : no('This invoice is not archived.');

  // ── mark paid / edit ──
  const mp = (status === 'draft' || OPEN_STATUSES.has(status)) && !processing
    ? yes
    : no(status === 'voided' ? 'This invoice is void. Restore it to draft first.' : 'This invoice is already settled.');
  const ed = (status === 'draft' || OPEN_STATUSES.has(status))
    ? yes
    : no(status === 'voided' ? 'Restore it to draft to edit it.' : 'Paid and refunded invoices are locked.');

  return { delete: del, void: vd, refund: rf, archive: ar, unarchive: un, markPaid: mp, edit: ed };
}

function fmtDay(ts, timeZone) {
  if (!ts) return null;
  const d = ts instanceof Date ? ts : new Date(String(ts).length === 10 ? `${ts}T12:00:00Z` : ts);
  if (Number.isNaN(d.getTime())) return null;
  try {
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', ...(timeZone ? { timeZone } : {}) });
  } catch {
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
}

function voidedAt(inv) {
  const activity = Array.isArray(inv?.activity) ? inv.activity : [];
  for (let i = activity.length - 1; i >= 0; i--) {
    if (activity[i]?.kind === 'voided') return activity[i].ts;
  }
  return field(inv, 'updatedAt', 'updated_at') || null;
}

// One plain sentence that says where the invoice stands, so "$0 net" is
// never a puzzle. Used by the owner's invoice drawer, the client portal,
// the public invoice page and Ivy.
export function invoiceStatusLine(inv, { timeZone } = {}) {
  const status = field(inv, 'status', 'status');
  const m = invoiceMoney(inv);
  const paidAt = fmtDay(field(inv, 'paidAt', 'paid_at'), timeZone);
  const refundedAt = fmtDay(field(inv, 'refundedAt', 'refunded_at'), timeZone);
  if (status === 'refunded' || (status === 'paid' && m.fullyRefunded && m.paid > 0)) {
    return `Refunded in full${refundedAt ? ` on ${refundedAt}` : ''}. Nothing owed.`;
  }
  if (status === 'paid') {
    if (m.refunded > 0) {
      return `Paid ${fmt(m.paid)}${paidAt ? ` on ${paidAt}` : ''}. ${fmt(m.refunded)} refunded${refundedAt ? ` on ${refundedAt}` : ''}. Net ${fmt(m.net)}. Nothing owed.`;
    }
    return `Paid${paidAt ? ` on ${paidAt}` : ''}. Nothing owed.`;
  }
  if (status === 'voided') {
    const at = fmtDay(voidedAt(inv), timeZone);
    return `Voided${at ? ` on ${at}` : ''}. Nothing owed.`;
  }
  if (OPEN_STATUSES.has(status)) {
    const parts = [];
    if (m.net > 0) parts.push(`${fmt(m.net)} paid so far.`);
    if (m.refunded > 0) parts.push(`${fmt(m.refunded)} refunded.`);
    if (m.giftCard > 0) parts.push(`${fmt(m.giftCard)} covered by a gift card.`);
    parts.push(`${fmt(m.owed)} owed${status === 'overdue' ? ' (overdue)' : ''}.`);
    return parts.join(' ');
  }
  if (status === 'draft') return 'Draft. Not sent yet, so nothing is owed.';
  return '';
}
