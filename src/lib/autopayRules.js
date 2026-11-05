// Autopay for recurring invoices: the words, shared by the server (consent
// text, emails, Ivy) and the browser (owner series + invoice, client
// portal). Pure: no database, no DOM.
//
// The consent text is built ONLY on the server from the series and the
// card on file; the browser shows a preview built by the same function so
// what the client reads is what gets stored.

export const AUTOPAY_RETRY_DAYS = 3;
export const AUTOPAY_MAX_ATTEMPTS = 2;

export const CADENCE_WORDS = {
  weekly: 'every week',
  biweekly: 'every 2 weeks',
  monthly: 'every month',
  quarterly: 'every 3 months',
  yearly: 'every year',
};

const BRANDS = {
  visa: 'Visa', mastercard: 'Mastercard', amex: 'American Express', discover: 'Discover',
  diners: 'Diners Club', jcb: 'JCB', unionpay: 'UnionPay', cartes_bancaires: 'Cartes Bancaires',
};

export function brandLabel(brand) {
  if (!brand) return 'Card';
  const b = String(brand).toLowerCase();
  return BRANDS[b] || (b.charAt(0).toUpperCase() + b.slice(1));
}

// "Visa ending in 4242"
export function cardLong(brand, last4) {
  return last4 ? `${brandLabel(brand)} ending in ${last4}` : `${brandLabel(brand)}`;
}
// "Visa 4242"
export function cardShort(brand, last4) {
  return last4 ? `${brandLabel(brand)} ${last4}` : brandLabel(brand);
}

export function fmtAmount(cents, currency = 'USD') {
  const n = Number(cents || 0) / 100;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: String(currency || 'USD').toUpperCase() }).format(n);
  } catch {
    return '$' + n.toFixed(2);
  }
}

// Dates are calendar days (YYYY-MM-DD) or timestamps; shown as "Nov 6, 2026".
export function fmtDay(v, { year = true } = {}) {
  if (!v) return '';
  const s = String(v);
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + 'T12:00:00Z') : new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(year ? { year: 'numeric' } : {}), timeZone: /^\d{4}-\d{2}-\d{2}$/.test(s) ? 'UTC' : undefined });
}

// The exact words the client agrees to. Everything a card network asks a
// recurring authorization to state: who charges, which card, how much (up
// to), how often, from when, and how to cancel.
export function buildConsentText({ businessName, seriesName, brand, last4, cadence, maxAmountCents, currency, startDate }) {
  const biz = businessName || 'This business';
  const how = CADENCE_WORDS[cadence] || 'on each billing date';
  const card = last4 ? `my ${cardLong(brand, last4)}` : 'the card I save';
  return [
    `I authorize ${biz} to charge ${card} automatically for each invoice in "${seriesName || 'this recurring series'}", billed ${how} starting ${fmtDay(startDate)}.`,
    `Each charge is the amount due on that invoice and never more than ${fmtAmount(maxAmountCents, currency)}.`,
    `I will get a receipt by email after each charge.`,
    `I can turn off automatic payments at any time in my client portal under Payments. After that, invoices are emailed to me to pay myself.`,
  ].join(' ');
}

// Series state for the owner: 'on' | 'waiting' | 'off'.
export function seriesAutopayLabel(autopay) {
  if (!autopay || autopay.state === 'off') return 'Autopay off';
  if (autopay.state === 'on') {
    return autopay.card ? `Autopay on (${cardShort(autopay.card.brand, autopay.card.last4)})` : 'Autopay on';
  }
  return 'Waiting for client to authorize';
}

const FAIL_WORDS = {
  card_declined: 'card declined',
  insufficient_funds: 'not enough funds on the card',
  expired_card: 'card expired',
  authentication_required: 'the bank asked the client to confirm the payment',
  card_unusable: 'the saved card could not be used',
  needs_check: 'Stripe did not answer, so it needs a check',
};
export function failureWords(code) {
  return FAIL_WORDS[code] || 'card declined';
}

const SKIP_WORDS = {
  waiting_for_authorization: 'the client has not authorized autopay yet',
  card_changed: 'the client changed their saved card and needs to authorize the new one',
  card_removed: 'the client removed their saved card',
  over_approved_amount: 'the amount is higher than the client approved',
  currency_changed: 'the currency is different from what the client approved',
  provider_changed: 'Stripe is no longer the payment provider',
  stripe_changed: 'the Stripe account changed since the client approved',
  partly_paid: 'part of it was already paid',
  nothing_due: 'nothing is left to pay',
  client_missing: 'the client is no longer on file',
};
export function skipWords(code) {
  return SKIP_WORDS[code] || 'autopay could not run';
}

// One line about autopay on an invoice, for the owner. null when the
// invoice has nothing to do with autopay.
export function invoiceAutopayLine(inv) {
  const st = inv?.autopayStatus;
  if (!st) return null;
  const card = inv.autopayCard ? cardLong(inv.autopayCard.brand, inv.autopayCard.last4) : 'the saved card';
  const open = inv.status === 'sent' || inv.status === 'overdue' || inv.status === 'draft';
  if (st === 'succeeded') return `Paid automatically with ${card}.`;
  if (st === 'processing') return `Automatic payment with ${card} is processing.`;
  if (st === 'charging') return `Charging ${card} automatically.`;
  if (st === 'retry_scheduled' || st === 'failed') {
    const when = fmtDay(inv.autopayFailedAt, { year: false });
    let s = `Automatic payment failed${when ? ` on ${when}` : ''}: ${failureWords(inv.autopayFailureCode)}.`;
    if (open && st === 'retry_scheduled' && inv.autopayRetryAt) s += ` Ivy will try once more on ${fmtDay(inv.autopayRetryAt, { year: false })} if it is still unpaid.`;
    else if (open) s += ' The client was sent the invoice to pay.';
    return s;
  }
  if (st === 'skipped') {
    if (inv.autopaySkipReason === 'waiting_for_authorization') return 'Waiting for client to authorize autopay, so this one is paid by link.';
    return `Not charged automatically: ${skipWords(inv.autopaySkipReason)}.`;
  }
  return null;
}

// The client-facing line (portal, emails). Never mentions internal codes.
export function invoiceAutopayClientLine(inv) {
  const st = inv?.autopayStatus;
  if (!st) return null;
  const card = inv.autopayCard ? cardLong(inv.autopayCard.brand, inv.autopayCard.last4) : 'your saved card';
  const open = inv.status === 'sent' || inv.status === 'overdue';
  if (st === 'succeeded') return `Paid automatically with ${card}.`;
  if (st === 'processing') return `Automatic payment with ${card} is processing.`;
  if ((st === 'retry_scheduled' || st === 'failed') && open) {
    const when = fmtDay(inv.autopayFailedAt, { year: false });
    const yours = inv.autopayCard ? `your ${card}` : card;
    return `We couldn't charge ${yours}${when ? ` on ${when}` : ''}. Please pay with the button below.`;
  }
  return null;
}
