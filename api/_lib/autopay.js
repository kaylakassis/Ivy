// Autopay for recurring invoices.
//
// Choice of rail: Ivy's recurring cron stays the scheduler and Ivy's
// invoice stays the record; Stripe holds the card (on the business's
// connected account) and moves the money with an off-session
// PaymentIntent. No Stripe Billing objects, so there is no second invoice
// system to keep in sync and no Billing fee on top of card pricing. Stripe
// still does what it is best at: the saved PaymentMethod (with card
// updates from the networks), the merchant-initiated off-session charge,
// idempotency, and the bank's decline reasons.
//
// The flow:
//   1. Owner turns it on for a series  -> requestAutopay(): an agreement row
//      'requested', the client gets an email + portal prompt.
//   2. Client agrees in the portal      -> authorizeAgreement(): the exact
//      words, time, IP, user agent, card and "up to" amount are stored once
//      and can never change (DB trigger). Status 'active'.
//   3. Cron mints the next invoice      -> chargeInvoiceAutopay(): claims the
//      invoice in the DB, then ONE PaymentIntent per attempt with a
//      per-invoice-per-attempt Idempotency-Key. Paid through the same
//      markInvoicePaid path as every other card payment (webhook-safe).
//   4. Decline                           -> invoice is emailed with a pay
//      link and a friendly note, owner notified, and at most ONE retry
//      AUTOPAY_RETRY_DAYS later when the bank's reason is temporary.
//
// Safety rails (each enforced here, not in the UI):
//   - no 'active' agreement for (workspace, series, client) -> no charge
//   - the card on file must be the very card the client approved
//   - amount = balance due, and never above the approved amount
//   - only draft/sent/overdue, unarchived, not processing, nothing paid yet
//   - Stripe account and live/test mode must match the approval
import crypto from 'node:crypto';
import { sql } from './db.js';
import { resolveMergedClientId } from './clientResolve.js';
import { computeTotals, fetchFinanceSettings } from './finance.js';
import { invoiceMoney } from '../../src/lib/invoiceRules.js';
import { loadStripeCreds } from './stripeCreds.js';
import {
  chargeOffSession, fetchCheckoutSession, fetchPaymentMethod, stripeFetch,
  setDefaultPaymentMethod, findOrCreateCustomer, createSetupCheckoutSession,
} from './stripe.js';
import { fulfillInvoicePaymentIntent, markInvoiceProcessing } from './checkoutFulfillment.js';
import { notifyOwnerSafe, notifyClientSafe } from './push.js';
import { sendEmailToClient, emailShell } from './email.js';
import { fetchBranding } from './branding.js';
import { appUrl, generateRawToken } from './tokens.js';
import {
  AUTOPAY_RETRY_DAYS, AUTOPAY_MAX_ATTEMPTS, CADENCE_WORDS,
  buildConsentText, cardLong, cardShort, fmtAmount, fmtDay, failureWords, skipWords,
} from '../../src/lib/autopayRules.js';

export { AUTOPAY_RETRY_DAYS, AUTOPAY_MAX_ATTEMPTS };

// A charge whose outcome we never heard (timeout, Stripe 5xx) is retried
// with the SAME idempotency key after this long, so Stripe answers with
// the original result instead of charging again. Stripe keeps keys for
// 24 hours; past RECOVERY_GIVE_UP_HOURS we stop and ask the owner to check.
const RECOVERY_AFTER_MINUTES = 15;
const RECOVERY_GIVE_UP_HOURS = 20;

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const dateStr = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : (v ? String(v).slice(0, 10) : null));
const firstName = (n) => (String(n || '').trim().split(/\s+/)[0] || 'there');

// Live vs test follows the key Ivy uses for this business (the platform key
// for Connect accounts, the business's own key on the legacy path). A card
// saved in test mode does not exist in live mode and vice versa; we also
// refuse to use an approval across modes.
export function stripeLivemode(creds) {
  return /^(sk|rk)_live_/.test(String(creds?.secretKey || ''));
}

// ─── Money ──────────────────────────────────────────────────────────

// What the client still owes on an invoice that may still be a draft:
// total (items, discount, tax) minus gift card credit minus money already
// kept. Same rules as every other screen (src/lib/invoiceRules.js).
export function balanceDueCents(inv) {
  if (!inv) return 0;
  if (!['draft', 'sent', 'overdue'].includes(inv.status)) return 0;
  const totals = computeTotals(inv.items || [], inv.tax_rate, inv.discount);
  const m = invoiceMoney({ ...inv, status: 'sent', total: totals.total });
  return Math.max(0, Math.round(m.owed * 100));
}

export function seriesTotalCents(series) {
  const t = computeTotals(series?.items || [], series?.tax_rate, series?.discount);
  return Math.round(t.total * 100);
}

// ─── Availability ───────────────────────────────────────────────────

const PROVIDER_NAMES = { square: 'Square', paypal: 'PayPal' };

// Off-session charges need a card kept on file with the payment provider.
// Ivy keeps cards on file only with Stripe today; Square and PayPal
// connections in Ivy take payments through a pay link and keep no card.
export async function autopayAvailability(workspaceId) {
  const settings = await fetchFinanceSettings(workspaceId);
  const provider = settings?.paymentProvider || 'stripe';
  if (provider !== 'stripe') {
    const name = PROVIDER_NAMES[provider] || 'Your payment provider';
    return {
      ok: false, provider, reason: 'provider',
      message: `Automatic payments need Stripe. ${name} in Ivy takes payments through a pay link and can't keep a client's card on file, so these invoices are emailed for your client to pay.`,
    };
  }
  if (!settings?.stripeConnectUserId && !settings?.stripeSecretEncrypted) {
    return {
      ok: false, provider, reason: 'not_connected',
      message: 'Connect Stripe under Finance to charge a client\'s saved card automatically.',
    };
  }
  if (settings?.stripeTaxEnabled) {
    // Stripe Tax works the tax out at checkout; an automatic charge has no
    // checkout, so it would collect the wrong tax. Say so instead.
    return {
      ok: false, provider, reason: 'stripe_tax',
      message: 'Automatic payments are not available while Stripe Tax is on, because Stripe works out the tax at checkout. These invoices are emailed for your client to pay.',
    };
  }
  return { ok: true, provider: 'stripe' };
}

// ─── Reading state ──────────────────────────────────────────────────

function summarizeAgreements(rows, clientCard) {
  const active = rows.find((a) => a.status === 'active') || null;
  const requested = rows.find((a) => a.status === 'requested') || null;
  const ended = rows.filter((a) => a.status === 'ended')
    .sort((a, b) => new Date(b.ended_at || 0) - new Date(a.ended_at || 0))[0] || null;
  const base = {
    state: active ? 'on' : requested ? 'waiting' : 'off',
    card: active ? { brand: active.card_brand, last4: active.card_last4 } : null,
    maxAmountCents: active ? active.max_amount_cents : null,
    currency: active?.currency || null,
    authorizedAt: active?.authorized_at || null,
    requestedAt: requested?.requested_at || null,
    requestEmailedAt: requested?.request_emailed_at || null,
    reapprovalRequested: !!(active && requested),
    cardChanged: !!(active && clientCard !== undefined && clientCard !== active.payment_method_id),
    lastEnded: !active && !requested && ended
      ? { at: ended.ended_at, by: ended.ended_by, reason: ended.ended_reason }
      : null,
  };
  return base;
}

// Map seriesId -> autopay summary for the owner's list / editor.
export async function autopayForSeries(workspaceId, series) {
  const out = new Map();
  const list = (series || []).filter(Boolean);
  if (!workspaceId || list.length === 0) return out;
  const ids = list.map((s) => s.id);
  let rows = [];
  try {
    ({ rows } = await sql.query(
      `SELECT a.id, a.recurring_invoice_id, a.client_id, a.status, a.requested_at, a.request_emailed_at,
              a.authorized_at, a.card_brand, a.card_last4, a.payment_method_id, a.max_amount_cents,
              a.currency, a.ended_at, a.ended_by, a.ended_reason,
              c.payment_method_id AS client_pm
         FROM autopay_agreements a
         LEFT JOIN clients c ON c.id = a.client_id AND c.workspace_id = a.workspace_id
        WHERE a.workspace_id = $1 AND a.recurring_invoice_id = ANY($2::uuid[])
        ORDER BY a.created_at DESC
        LIMIT 2000`,
      [workspaceId, ids],
    ));
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[autopay] series lookup failed:', e.message);
  }
  for (const s of list) {
    const mine = rows.filter((r) => r.recurring_invoice_id === s.id && (r.status === 'ended' || r.client_id === s.client_id));
    const active = mine.find((r) => r.status === 'active');
    const sum = summarizeAgreements(mine, active ? (active.client_pm || null) : undefined);
    const total = seriesTotalCents(s);
    sum.overApproved = !!(active && total > Number(active.max_amount_cents || 0));
    out.set(s.id, sum);
  }
  return out;
}

// serializeRecurring() + the autopay summary, for owner endpoints. Never
// throws: a lookup failure shows "Autopay off" rather than breaking the
// Recurring tab.
export async function withAutopay(workspaceId, rows, serialize) {
  let map = new Map();
  let availability = { ok: false, reason: 'unknown', message: null };
  try {
    [map, availability] = await Promise.all([autopayForSeries(workspaceId, rows), autopayAvailability(workspaceId)]);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[autopay] summary failed:', e.message);
  }
  return rows.map((r) => ({
    ...serialize(r),
    autopay: map.get(r.id) || { state: 'off', card: null },
    autopayAvailable: !!availability.ok,
    autopayUnavailableReason: availability.ok ? null : (availability.message || null),
  }));
}

// ─── Owner: ask / stop ──────────────────────────────────────────────

export class AutopayError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

async function loadSeries(workspaceId, seriesId) {
  const r = await sql`SELECT * FROM recurring_invoices WHERE id = ${seriesId} AND workspace_id = ${workspaceId}`;
  return r.rows[0] || null;
}

// Owner turns autopay on (or asks again after a price rise or a card
// change). Creates or reuses the single 'requested' row for the series and
// emails the client. Re-sending is limited to once an hour.
export async function requestAutopay({ workspaceId, seriesId, userId }) {
  const s = await loadSeries(workspaceId, seriesId);
  if (!s) throw new AutopayError('Schedule not found', 404);
  if (s.status === 'ended') throw new AutopayError('This series has ended. Start a new series to use automatic payments.');
  if (!s.client_id) throw new AutopayError('Pick a client for this series first.');
  const avail = await autopayAvailability(workspaceId);
  if (!avail.ok) throw new AutopayError(avail.message);
  const cl = await sql`SELECT id, name, email FROM clients WHERE id = ${s.client_id} AND workspace_id = ${workspaceId}`;
  const client = cl.rows[0];
  if (!client) throw new AutopayError('Pick a client for this series first.');
  if (!client.email) throw new AutopayError('This client has no email address. Add one so they can approve automatic payments.');
  if (!(seriesTotalCents(s) > 0)) throw new AutopayError('Add line items with a total above zero first.');

  const existing = await sql`
    SELECT * FROM autopay_agreements
     WHERE workspace_id = ${workspaceId} AND recurring_invoice_id = ${s.id}
       AND client_id = ${s.client_id} AND status IN ('requested', 'active')
  `;
  const active = existing.rows.find((a) => a.status === 'active');
  let requested = existing.rows.find((a) => a.status === 'requested');
  if (active && !requested) {
    // Already on. A new request is only useful when the old approval no
    // longer covers the series (price went up, or the card changed).
    const pm = (await sql`SELECT payment_method_id FROM clients WHERE id = ${s.client_id} AND workspace_id = ${workspaceId}`).rows[0]?.payment_method_id || null;
    const covers = seriesTotalCents(s) <= Number(active.max_amount_cents || 0) && pm === active.payment_method_id;
    if (covers) return { created: false, emailed: false, state: 'on' };
  }
  let created = false;
  if (!requested) {
    const ins = await sql`
      INSERT INTO autopay_agreements (workspace_id, recurring_invoice_id, client_id, status, requested_by, series_name, cadence, currency)
      VALUES (${workspaceId}, ${s.id}, ${s.client_id}, 'requested', ${userId || null}, ${s.name}, ${s.cadence}, ${String(s.currency || 'USD').toUpperCase()})
      ON CONFLICT (recurring_invoice_id) WHERE status = 'requested' DO NOTHING
      RETURNING *
    `;
    requested = ins.rows[0];
    if (!requested) {
      requested = (await sql`SELECT * FROM autopay_agreements WHERE recurring_invoice_id = ${s.id} AND status = 'requested' AND workspace_id = ${workspaceId}`).rows[0];
    } else {
      created = true;
    }
  }
  if (!requested) throw new AutopayError('Could not create the request. Please try again.', 500);

  // Email at most once an hour per request (the owner may tap "send again").
  const claim = await sql`
    UPDATE autopay_agreements SET request_emailed_at = NOW(), updated_at = NOW()
     WHERE id = ${requested.id} AND workspace_id = ${workspaceId} AND status = 'requested'
       AND (request_emailed_at IS NULL OR request_emailed_at < NOW() - INTERVAL '1 hour')
     RETURNING id
  `;
  let emailed = false;
  if (claim.rows.length) {
    emailed = await sendAuthorizationRequest({ series: s, client, agreementId: requested.id, reapproval: !!active });
  }
  return { created, emailed, state: active ? 'on' : 'waiting', agreementId: requested.id };
}

async function sendAuthorizationRequest({ series, client, agreementId, reapproval }) {
  const branding = await fetchBranding(series.workspace_id);
  const biz = branding.businessName || 'Your provider';
  const total = fmtAmount(seriesTotalCents(series), series.currency);
  const how = CADENCE_WORDS[series.cadence] || 'on a schedule';
  const link = `${appUrl()}/me/invoices?autopay=${encodeURIComponent(agreementId)}#autopay`;
  const html = emailShell({
    heading: reapproval ? 'Please approve automatic payments again' : 'Pay your invoices automatically?',
    branding,
    preheader: `${biz} invoices you ${how}. Approve once and each invoice is paid with your saved card.`,
    body: `<p>Hi ${escapeHtml(firstName(client.name))},</p>
      <p>${escapeHtml(biz)} sends you an invoice ${escapeHtml(how)} for <b>${escapeHtml(series.name)}</b> (${escapeHtml(total)} each).</p>
      <p>${reapproval
        ? 'Something changed since you approved automatic payments (the amount or your card), so they need your OK again before charging.'
        : 'They asked if you would like each invoice paid automatically with a card you keep on file with them.'}
      Nothing is charged until you agree, and you can turn it off at any time.</p>
      <p>Sign in with this email address (or create your free account) to review the details.</p>`,
    ctaText: 'Review and approve',
    ctaUrl: link,
    footer: 'If you would rather keep paying each invoice yourself, just ignore this email.',
  });
  const r = await sendEmailToClient({
    clientId: client.id, type: 'receipts', to: client.email,
    subject: reapproval ? `Approve automatic payments again for ${biz}` : `${biz} asked about automatic payments`,
    html, replyTo: branding.replyTo,
  });
  notifyClientSafe({
    clientId: client.id, type: 'payments',
    payload: {
      title: 'Approve automatic payments?',
      body: `${biz} · ${series.name} · ${total} ${how}`,
      url: `/me/invoices?autopay=${agreementId}#autopay`,
      tag: `autopay-request-${agreementId}`,
    },
  });
  return !!r?.sent;
}

// End agreements. Returns the rows that actually ended (so callers only
// notify about real changes). by: 'owner' | 'client' | 'system'.
export async function endAgreements({ workspaceId, seriesId = null, clientId = null, agreementId = null, by, reason, statuses = ['requested', 'active'] }) {
  if (!workspaceId || (!seriesId && !clientId && !agreementId)) return [];
  const { rows } = await sql.query(
    `UPDATE autopay_agreements SET status = 'ended', ended_at = NOW(), ended_by = $1, ended_reason = $2, updated_at = NOW()
      WHERE workspace_id = $3
        AND status = ANY($4::text[])
        AND ($5::uuid IS NULL OR recurring_invoice_id = $5)
        AND ($6::uuid IS NULL OR client_id = $6)
        AND ($7::uuid IS NULL OR id = $7)
      RETURNING *`,
    [by, reason, workspaceId, statuses, seriesId, clientId, agreementId],
  );
  return rows;
}

// Owner turns autopay off. The client is told when an active approval
// ended (they would otherwise expect to be charged).
export async function ownerTurnOff({ workspaceId, seriesId }) {
  const ended = await endAgreements({ workspaceId, seriesId, by: 'owner', reason: 'owner_turned_off' });
  for (const a of ended.filter((x) => x.authorized_at && x.client_id)) {
    // eslint-disable-next-line no-await-in-loop
    await tellClientAutopayEnded(a, 'owner');
  }
  return ended.length;
}

// Series stopped / deleted / client switched: end quietly for requested
// ones, tell the client about active ones.
export async function stopForSeries({ workspaceId, seriesId, reason }) {
  const ended = await endAgreements({ workspaceId, seriesId, by: 'system', reason });
  for (const a of ended.filter((x) => x.authorized_at && x.client_id)) {
    // eslint-disable-next-line no-await-in-loop
    await tellClientAutopayEnded(a, 'series');
  }
  return ended.length;
}

async function tellClientAutopayEnded(a, why) {
  try {
    const cl = (await sql`SELECT id, name, email FROM clients WHERE id = ${a.client_id} AND workspace_id = ${a.workspace_id}`).rows[0];
    if (!cl?.email) return;
    const branding = await fetchBranding(a.workspace_id);
    const biz = branding.businessName || 'Your provider';
    const line = why === 'series'
      ? `The recurring invoices for <b>${escapeHtml(a.series_name || 'your series')}</b> have stopped, so automatic payments with your ${escapeHtml(cardLong(a.card_brand, a.card_last4))} are off too.`
      : `${escapeHtml(biz)} turned off automatic payments for <b>${escapeHtml(a.series_name || 'your invoices')}</b>. Your ${escapeHtml(cardLong(a.card_brand, a.card_last4))} will not be charged automatically. Any new invoice will be emailed to you to pay.`;
    await sendEmailToClient({
      clientId: cl.id, type: 'receipts', to: cl.email,
      subject: `Automatic payments turned off · ${biz}`,
      html: emailShell({ heading: 'Automatic payments are off', branding, body: `<p>Hi ${escapeHtml(firstName(cl.name))},</p><p>${line}</p>` }),
      replyTo: branding.replyTo,
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[autopay] ended email failed:', e.message);
  }
}

function notifyOwnerAutopayEnded(a, clientName, why) {
  const who = clientName || 'Your client';
  const what = why === 'card_removed'
    ? `${who} removed their saved card, so autopay for ${a.series_name || 'a series'} is off.`
    : `${who} turned off autopay for ${a.series_name || 'a series'}.`;
  notifyOwnerSafe({
    workspaceId: a.workspace_id, type: 'payments',
    payload: {
      title: 'Autopay turned off',
      body: `${what} Next invoices are emailed for them to pay.`,
      url: '/finance?section=recurring',
      tag: `autopay-ended-${a.id}`,
    },
  });
}

// The client removed their saved card for this business (portal). Any
// approval tied to that card is over; the owner is told.
export async function endForRemovedCard({ workspaceId, clientId }) {
  const ended = await endAgreements({ workspaceId, clientId, by: 'client', reason: 'card_removed', statuses: ['active'] });
  if (ended.length) {
    const cl = (await sql`SELECT name FROM clients WHERE id = ${clientId} AND workspace_id = ${workspaceId}`).rows[0];
    for (const a of ended) notifyOwnerAutopayEnded(a, cl?.name, 'card_removed');
  }
  return ended.length;
}

// Daily housekeeping: approvals whose client or series was deleted can
// never be used again; mark them ended so every screen agrees.
export async function endOrphanedAgreements() {
  const r = await sql`
    UPDATE autopay_agreements SET status = 'ended', ended_at = NOW(), ended_by = 'system',
           ended_reason = CASE WHEN client_id IS NULL THEN 'client_deleted' ELSE 'series_deleted' END,
           updated_at = NOW()
     WHERE status IN ('requested', 'active') AND (client_id IS NULL OR recurring_invoice_id IS NULL)
     RETURNING id
  `;
  return r.rows.length;
}

// ─── Client portal ──────────────────────────────────────────────────

function serializeForClient(row, termsCard) {
  const card = row.status === 'active'
    ? { brand: row.card_brand, last4: row.card_last4 }
    : null;
  const savedCard = row.client_pm ? { brand: row.client_brand, last4: row.client_last4 } : null;
  const seriesTotal = seriesTotalCents({ items: row.s_items, tax_rate: row.s_tax_rate, discount: row.s_discount });
  const startDate = dateStr(row.s_next_run_at);
  const maxCents = row.status === 'active' ? row.max_amount_cents : seriesTotal;
  const currency = (row.status === 'active' ? row.currency : row.s_currency) || 'USD';
  const out = {
    id: row.id,
    status: row.status,
    businessName: row.biz_name || 'Business',
    seriesName: row.status === 'active' ? row.series_name : (row.s_name || row.series_name),
    cadence: row.status === 'active' ? row.cadence : (row.s_cadence || row.cadence),
    amountCents: maxCents,
    currency: String(currency).toUpperCase(),
    nextInvoiceDate: row.s_status === 'active' ? startDate : null,
    card,
    savedCard,
    cardChanged: row.status === 'active' && row.client_pm !== row.payment_method_id,
    requestedAt: row.requested_at,
    authorizedAt: row.authorized_at,
    endedAt: row.ended_at,
    endedBy: row.ended_by,
    canAddCard: !!row.client_email,
  };
  if (row.status === 'active') {
    out.terms = row.consent_text;
  } else if (row.status === 'requested') {
    const c = termsCard || savedCard;
    out.terms = buildConsentText({
      businessName: out.businessName, seriesName: out.seriesName,
      brand: c?.brand, last4: c?.last4, cadence: out.cadence,
      maxAmountCents: maxCents, currency: out.currency, startDate,
    });
  }
  return out;
}

const PORTAL_SELECT = `
  SELECT a.*, cs.biz_name,
         c.payment_method_id AS client_pm, c.payment_method_brand AS client_brand,
         c.payment_method_last4 AS client_last4, c.email AS client_email,
         s.name AS s_name, s.items AS s_items, s.tax_rate AS s_tax_rate, s.discount AS s_discount,
         s.next_run_at AS s_next_run_at, s.cadence AS s_cadence, s.status AS s_status,
         s.currency AS s_currency, s.client_id AS s_client_id
    FROM autopay_agreements a
    JOIN clients c ON c.id = a.client_id AND c.workspace_id = a.workspace_id
    LEFT JOIN recurring_invoices s ON s.id = a.recurring_invoice_id AND s.workspace_id = a.workspace_id
    LEFT JOIN calendar_settings cs ON cs.workspace_id = a.workspace_id`;

export async function listForClient(myIds) {
  if (!myIds?.length) return [];
  const { rows } = await sql.query(
    `${PORTAL_SELECT}
      WHERE a.client_id = ANY($1::uuid[])
        AND (a.status IN ('requested', 'active') OR a.ended_at > NOW() - INTERVAL '60 days')
      ORDER BY CASE a.status WHEN 'requested' THEN 0 WHEN 'active' THEN 1 ELSE 2 END, a.created_at DESC
      LIMIT 100`,
    [myIds],
  );
  return rows.map((r) => serializeForClient(r));
}

async function loadForClient(myIds, agreementId) {
  if (!agreementId || !/^[0-9a-f-]{36}$/i.test(String(agreementId))) return null;
  const { rows } = await sql.query(`${PORTAL_SELECT} WHERE a.id = $1 AND a.client_id = ANY($2::uuid[]) LIMIT 1`, [agreementId, myIds]);
  return rows[0] || null;
}

// Stripe Checkout in setup mode on the business's connected account. The
// return URL brings the client back to the same approval.
export async function startAddCard({ myIds, agreementId }) {
  const a = await loadForClient(myIds, agreementId);
  if (!a || a.status === 'ended') throw new AutopayError('This request is no longer open.', 404);
  const cl = (await sql`SELECT id, workspace_id, name, email, stripe_customer_id FROM clients WHERE id = ${a.client_id} AND workspace_id = ${a.workspace_id}`).rows[0];
  if (!cl?.email) throw new AutopayError('No email on file - ask the business to add one first.');
  const avail = await autopayAvailability(a.workspace_id);
  if (!avail.ok) throw new AutopayError("This business can't take automatic card payments right now.");
  const creds = await loadStripeCreds(a.workspace_id);
  let customerId = cl.stripe_customer_id;
  if (!customerId) {
    const cust = await findOrCreateCustomer({
      secretKey: creds.secretKey, stripeAccount: creds.stripeAccount,
      email: cl.email, name: cl.name, workspaceId: cl.workspace_id, clientId: cl.id,
    });
    customerId = cust.id;
    await sql`UPDATE clients SET stripe_customer_id = ${customerId}, updated_at = NOW() WHERE id = ${cl.id} AND workspace_id = ${cl.workspace_id}`;
  }
  const base = `${appUrl()}/me/invoices?autopay=${encodeURIComponent(a.id)}`;
  const session = await createSetupCheckoutSession({
    secretKey: creds.secretKey, stripeAccount: creds.stripeAccount,
    customerId, workspaceId: cl.workspace_id, clientId: cl.id,
    successUrl: `${base}&setup={CHECKOUT_SESSION_ID}#autopay`,
    cancelUrl: `${base}&setup=cancel#autopay`,
  });
  return { url: session.url };
}

// Back from Stripe: read the finished setup session ourselves (no need to
// wait for the webhook) and keep the card on the client row exactly like
// the portal's save-card webhook does. Only a session minted for THIS
// client in THIS business is accepted.
export async function syncSetupSession({ myIds, agreementId, sessionId }) {
  const a = await loadForClient(myIds, agreementId);
  if (!a || a.status === 'ended') throw new AutopayError('This request is no longer open.', 404);
  if (!/^cs_[A-Za-z0-9_]{1,200}$/.test(String(sessionId || ''))) throw new AutopayError('Unknown card setup.');
  const creds = await loadStripeCreds(a.workspace_id);
  const session = await fetchCheckoutSession({ secretKey: creds.secretKey, stripeAccount: creds.stripeAccount, sessionId });
  // The setup may have started on a record merged into this client since.
  const mdClient = await resolveMergedClientId(a.workspace_id, session?.metadata?.client_id);
  if (session?.mode !== 'setup' || session?.status !== 'complete'
      || mdClient !== a.client_id || session?.metadata?.workspace_id !== a.workspace_id) {
    throw new AutopayError('That card setup did not finish. Please try again.');
  }
  const siId = typeof session.setup_intent === 'string' ? session.setup_intent : session.setup_intent?.id;
  if (!siId) throw new AutopayError('That card setup did not finish. Please try again.');
  const si = await stripeFetch(`/setup_intents/${encodeURIComponent(siId)}`, { secretKey: creds.secretKey, stripeAccount: creds.stripeAccount });
  const pmId = typeof si.payment_method === 'string' ? si.payment_method : si.payment_method?.id;
  if (si.status !== 'succeeded' || !pmId) throw new AutopayError('That card setup did not finish. Please try again.');
  const pm = await fetchPaymentMethod({ secretKey: creds.secretKey, stripeAccount: creds.stripeAccount, paymentMethodId: pmId });
  if (pm?.type && pm.type !== 'card') throw new AutopayError('Please use a card for automatic payments.');
  const card = pm.card || {};
  const customer = typeof session.customer === 'string' ? session.customer : session.customer?.id || null;
  await sql`
    UPDATE clients SET
      stripe_customer_id = COALESCE(${customer}, stripe_customer_id),
      payment_method_id = ${pmId},
      payment_method_brand = ${card.brand || null},
      payment_method_last4 = ${card.last4 || null},
      payment_method_exp_month = ${card.exp_month || null},
      payment_method_exp_year = ${card.exp_year || null},
      updated_at = NOW()
    WHERE id = ${a.client_id} AND workspace_id = ${a.workspace_id}
  `;
  if (customer) {
    try {
      await setDefaultPaymentMethod({ secretKey: creds.secretKey, stripeAccount: creds.stripeAccount, customerId: customer, paymentMethodId: pmId });
    } catch { /* non-fatal */ }
  }
  return { brand: card.brand || null, last4: card.last4 || null };
}

// The client agrees. Everything stored comes from the server: the series,
// the business, the card on file (re-read from Stripe), the cap (the
// series total right now). The words are built once and kept forever.
export async function authorizeAgreement({ user, myIds, agreementId, ip, userAgent }) {
  let a = await loadForClient(myIds, agreementId);
  if (!a || a.status === 'ended') throw new AutopayError('This request is no longer open. Ask the business to send a new one.', 404);
  if (!a.recurring_invoice_id || !a.s_name) throw new AutopayError('This series no longer exists.', 404);
  if (a.s_status === 'ended') throw new AutopayError('This series has ended, so there is nothing to pay automatically.');
  if (a.s_client_id !== a.client_id) throw new AutopayError('This request is no longer open.', 404);
  if (!a.client_pm) throw new AutopayError('Add a card first.');

  // A client whose card changed re-approves an active agreement: the old
  // approval ends and a fresh one starts with the new card.
  if (a.status === 'active') {
    if (a.client_pm === a.payment_method_id) return { already: true };
    let req = (await sql`SELECT id FROM autopay_agreements WHERE recurring_invoice_id = ${a.recurring_invoice_id} AND workspace_id = ${a.workspace_id} AND status = 'requested'`).rows[0];
    if (!req) {
      req = (await sql`
        INSERT INTO autopay_agreements (workspace_id, recurring_invoice_id, client_id, status, series_name, cadence, currency)
        VALUES (${a.workspace_id}, ${a.recurring_invoice_id}, ${a.client_id}, 'requested', ${a.s_name}, ${a.s_cadence}, ${String(a.s_currency || 'USD').toUpperCase()})
        ON CONFLICT (recurring_invoice_id) WHERE status = 'requested' DO NOTHING
        RETURNING id
      `).rows[0] || (await sql`SELECT id FROM autopay_agreements WHERE recurring_invoice_id = ${a.recurring_invoice_id} AND workspace_id = ${a.workspace_id} AND status = 'requested'`).rows[0];
    }
    a = await loadForClient(myIds, req.id);
    if (!a) throw new AutopayError('Please try again.', 409);
  }

  const avail = await autopayAvailability(a.workspace_id);
  if (!avail.ok) throw new AutopayError("This business can't take automatic card payments right now.");
  const creds = await loadStripeCreds(a.workspace_id);
  const cl = (await sql`SELECT id, stripe_customer_id, payment_method_id FROM clients WHERE id = ${a.client_id} AND workspace_id = ${a.workspace_id}`).rows[0];
  if (!cl?.payment_method_id || !cl?.stripe_customer_id) throw new AutopayError('Add a card first.');
  // Re-read the card from Stripe: it must still exist, be a card, and
  // belong to this client's customer on this business's account.
  let pm;
  try {
    pm = await fetchPaymentMethod({ secretKey: creds.secretKey, stripeAccount: creds.stripeAccount, paymentMethodId: cl.payment_method_id });
  } catch {
    throw new AutopayError('We could not find your saved card. Please add it again.');
  }
  const pmCustomer = typeof pm?.customer === 'string' ? pm.customer : pm?.customer?.id;
  if (pm?.type !== 'card' || (pmCustomer && pmCustomer !== cl.stripe_customer_id)) {
    throw new AutopayError('We could not use your saved card. Please add it again.');
  }
  const card = pm.card || {};
  const maxAmountCents = seriesTotalCents({ items: a.s_items, tax_rate: a.s_tax_rate, discount: a.s_discount });
  if (!(maxAmountCents > 0)) throw new AutopayError('This series has nothing to pay yet.');
  const currency = String(a.s_currency || 'USD').toUpperCase();
  const startDate = dateStr(a.s_next_run_at);
  const text = buildConsentText({
    businessName: a.biz_name || 'This business', seriesName: a.s_name,
    brand: card.brand, last4: card.last4, cadence: a.s_cadence,
    maxAmountCents, currency, startDate,
  });

  // One active approval per series: the old one (if any) is replaced.
  const replaced = await endAgreements({ workspaceId: a.workspace_id, seriesId: a.recurring_invoice_id, by: 'client', reason: 'replaced', statuses: ['active'] });
  const upd = await sql`
    UPDATE autopay_agreements SET
      status = 'active', authorized_at = NOW(),
      consent_text = ${text}, consent_ip = ${String(ip || '').slice(0, 64) || null},
      consent_user_agent = ${String(userAgent || '').slice(0, 500) || null},
      consent_user_id = ${user.id},
      payment_method_id = ${cl.payment_method_id}, stripe_customer_id = ${cl.stripe_customer_id},
      stripe_account = ${creds.stripeAccount || null}, livemode = ${stripeLivemode(creds)},
      card_brand = ${card.brand || null}, card_last4 = ${card.last4 || null},
      max_amount_cents = ${maxAmountCents}, currency = ${currency},
      cadence = ${a.s_cadence}, start_date = ${startDate}, series_name = ${a.s_name},
      updated_at = NOW()
    WHERE id = ${a.id} AND workspace_id = ${a.workspace_id} AND status = 'requested'
      AND client_id = ${a.client_id}
    RETURNING *
  `;
  const row = upd.rows[0];
  if (!row) throw new AutopayError('This request changed while you were looking. Please refresh.', 409);
  notifyOwnerSafe({
    workspaceId: a.workspace_id, type: 'payments',
    payload: {
      title: replaced.length ? 'Autopay card updated' : 'Autopay approved',
      body: `Your client approved automatic payments for ${a.s_name} (${cardShort(card.brand, card.last4)}, up to ${fmtAmount(maxAmountCents, currency)}).`,
      url: '/finance?section=recurring',
      tag: `autopay-approved-${row.id}`,
    },
  });
  return { agreement: row };
}

export async function clientTurnOff({ myIds, agreementId }) {
  const a = await loadForClient(myIds, agreementId);
  if (!a) throw new AutopayError('Not found', 404);
  if (a.status === 'ended') return { ended: false };
  const ended = await endAgreements({ workspaceId: a.workspace_id, agreementId: a.id, by: 'client', reason: a.status === 'active' ? 'client_turned_off' : 'client_declined' });
  for (const x of ended) {
    const cl = (await sql`SELECT name FROM clients WHERE id = ${x.client_id} AND workspace_id = ${x.workspace_id}`).rows[0]; // eslint-disable-line no-await-in-loop
    if (x.authorized_at) notifyOwnerAutopayEnded(x, cl?.name, 'client');
    else {
      notifyOwnerSafe({
        workspaceId: x.workspace_id, type: 'payments',
        payload: {
          title: 'Autopay declined',
          body: `${cl?.name || 'Your client'} would rather pay ${x.series_name || 'these invoices'} by hand. Invoices are emailed with a pay link.`,
          url: '/finance?section=recurring',
          tag: `autopay-ended-${x.id}`,
        },
      });
    }
  }
  return { ended: ended.length > 0 };
}

// ─── Charging ───────────────────────────────────────────────────────

// Temporary bank reasons worth exactly one more try a few days later
// (money arrives on payday, a bank hiccup clears). Everything else needs
// the client to act (new card, confirm with the bank), so retrying would
// only add declines to their statement history.
const RETRYABLE = new Set([
  'insufficient_funds', 'processing_error', 'try_again_later', 'issuer_not_available',
  'reenter_transaction', 'generic_decline', 'do_not_honor', 'approve_with_id',
  'card_velocity_exceeded', 'withdrawal_count_limit_exceeded', 'call_issuer', 'rate_limit',
]);

export function classifyChargeError(err) {
  const code = err?.stripeCode || null;
  const decline = err?.declineCode || null;
  if (code === 'authentication_required' || decline === 'authentication_required') {
    return { kind: 'failed', code: 'authentication_required', retryable: false };
  }
  if (code === 'expired_card' || decline === 'expired_card') return { kind: 'failed', code: 'expired_card', retryable: false };
  if (decline === 'insufficient_funds') return { kind: 'failed', code: 'insufficient_funds', retryable: true };
  if (code === 'card_declined' || err?.stripeType === 'card_error' || err?.status === 402) {
    return { kind: 'failed', code: 'card_declined', retryable: RETRYABLE.has(decline || '') };
  }
  // No answer, Stripe trouble, or rate limited: we do not know if money
  // moved. Keep the claim and ask again later with the same key.
  if (!err?.status || err.status >= 500 || err.status === 429 || code === 'idempotency_key_in_use') {
    return { kind: 'unknown' };
  }
  // 400-class request errors: the saved card is gone or unusable.
  return { kind: 'failed', code: 'card_unusable', retryable: false };
}

async function setSkip(inv, reason, agreementId = null) {
  await sql`
    UPDATE invoices SET autopay_status = 'skipped', autopay_skip_reason = ${reason},
           autopay_agreement_id = COALESCE(${agreementId}, autopay_agreement_id), updated_at = NOW()
     WHERE id = ${inv.id} AND workspace_id = ${inv.workspace_id}
       AND (autopay_status IS NULL OR autopay_status = 'skipped')
  `;
}

function appendActivity(text, kind = 'autopay') {
  return JSON.stringify([{ ts: new Date().toISOString(), kind, text }]);
}

// Called by the cron right after it mints a series invoice (retry=false),
// and by the sweep for a scheduled retry (retry=true). Returns
//   { outcome: 'no_consent' }          nothing to do, send normally
//   { outcome: 'waiting' }             client hasn't approved yet, send normally
//   { outcome: 'skipped', reason }     approval exists but can't be used now
//   { outcome: 'claimed_elsewhere' }   another run owns this invoice
//   { outcome: 'succeeded' | 'processing' | 'failed' | 'unknown', ... }
export async function chargeInvoiceAutopay({ workspaceId, invoiceId, retry = false }) {
  const invR = await sql`SELECT * FROM invoices WHERE id = ${invoiceId} AND workspace_id = ${workspaceId}`;
  const inv = invR.rows[0];
  if (!inv || !inv.recurring_invoice_id || !inv.client_id) return { outcome: 'no_consent' };
  // Paid, refunded, void or archived: never charged, and nothing to say.
  if (!['draft', 'sent', 'overdue'].includes(inv.status) || inv.archived_at) return { outcome: 'not_open' };

  const agR = await sql`
    SELECT * FROM autopay_agreements
     WHERE workspace_id = ${workspaceId} AND recurring_invoice_id = ${inv.recurring_invoice_id}
       AND client_id = ${inv.client_id} AND status IN ('active', 'requested')
     ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END LIMIT 1
  `;
  const ag = agR.rows[0];
  if (!ag) return { outcome: 'no_consent' };
  if (ag.status !== 'active' || !ag.authorized_at || !ag.consent_text) {
    if (!retry) await setSkip(inv, 'waiting_for_authorization', ag.id);
    return { outcome: 'waiting' };
  }

  // Pre-checks that do not need Stripe. Each one is a reason the owner
  // (and the invoice) can show in plain words.
  const skip = async (reason) => {
    if (!retry) {
      await setSkip(inv, reason, ag.id);
      notifyOwnerSafe({
        workspaceId, type: 'payments',
        payload: {
          title: 'Autopay did not run',
          body: `${inv.client_name || 'Client'} · ${inv.number}: ${skipWords(reason)}.`,
          url: `/finance?invoice=${inv.id}`,
          tag: `autopay-skip-${inv.id}`,
        },
      });
    }
    return { outcome: 'skipped', reason };
  };
  const client = (await sql`SELECT id, payment_method_id, stripe_customer_id FROM clients WHERE id = ${inv.client_id} AND workspace_id = ${workspaceId}`).rows[0];
  if (!client) return skip('client_missing');
  if (!client.payment_method_id) return skip('card_removed');
  if (client.payment_method_id !== ag.payment_method_id || client.stripe_customer_id !== ag.stripe_customer_id) return skip('card_changed');
  const avail = await autopayAvailability(workspaceId);
  if (!avail.ok) return skip('provider_changed');
  let creds;
  try { creds = await loadStripeCreds(workspaceId); } catch { return skip('provider_changed'); }
  if ((creds.stripeAccount || null) !== (ag.stripe_account || null) || stripeLivemode(creds) !== !!ag.livemode) return skip('stripe_changed');
  if (String(inv.currency || 'USD').toUpperCase() !== String(ag.currency || '').toUpperCase()) return skip('currency_changed');
  // Part-paid (net of refunds: a part payment the owner gave back no
  // longer counts) is left to the client.
  if (Number(inv.paid_amount || 0) - Number(inv.refunded_amount || 0) > 0.005) return skip('partly_paid');
  const due0 = balanceDueCents(inv);
  if (due0 <= 0) return skip('nothing_due');
  if (due0 > Number(ag.max_amount_cents)) return skip('over_approved_amount');

  // Claim the invoice BEFORE talking to Stripe. Exactly one caller wins
  // each attempt; the attempt number is part of the idempotency key.
  const claim = await sql`
    UPDATE invoices SET
      autopay_status = 'charging',
      autopay_attempts = autopay_attempts + 1,
      autopay_last_attempt_at = NOW(),
      autopay_retry_at = NULL,
      autopay_skip_reason = NULL,
      autopay_agreement_id = ${ag.id},
      autopay_card_brand = ${ag.card_brand},
      autopay_card_last4 = ${ag.card_last4},
      autopay_amount_cents = NULL,
      autopay_claimed_at = NOW(),
      updated_at = NOW()
    WHERE id = ${inv.id} AND workspace_id = ${workspaceId}
      AND status IN ('draft', 'sent', 'overdue')
      AND archived_at IS NULL
      AND payment_processing_at IS NULL
      AND COALESCE(paid_amount, 0) - COALESCE(refunded_amount, 0) <= 0.005
      AND autopay_attempts < ${AUTOPAY_MAX_ATTEMPTS}
      AND (
        (${!retry} AND (autopay_status IS NULL OR autopay_status = 'skipped') AND autopay_attempts = 0)
        OR (${retry} AND autopay_status = 'retry_scheduled' AND autopay_retry_at <= NOW())
      )
    RETURNING *
  `;
  const claimed = claim.rows[0];
  if (!claimed) return { outcome: 'claimed_elsewhere' };

  // Re-check the amount on the row we now own (an edit could have landed
  // between the read above and the claim).
  const amountCents = balanceDueCents(claimed);
  if (amountCents <= 0 || amountCents > Number(ag.max_amount_cents)) {
    const reason = amountCents <= 0 ? 'nothing_due' : 'over_approved_amount';
    await sql`
      UPDATE invoices SET autopay_status = 'skipped', autopay_skip_reason = ${reason},
             autopay_attempts = GREATEST(autopay_attempts - 1, 0), updated_at = NOW()
       WHERE id = ${inv.id} AND workspace_id = ${workspaceId} AND autopay_status = 'charging'
    `;
    return { outcome: 'skipped', reason };
  }
  await sql`UPDATE invoices SET autopay_amount_cents = ${amountCents} WHERE id = ${inv.id} AND workspace_id = ${workspaceId} AND autopay_status = 'charging'`;
  const attempt = claimed.autopay_attempts;
  return runCharge({ inv: claimed, ag, creds, amountCents, attempt });
}

function idemKey(invoiceId, attempt) {
  return `ivy-autopay-${invoiceId}-a${attempt}`;
}

async function runCharge({ inv, ag, creds, amountCents, attempt }) {
  const workspaceId = inv.workspace_id;
  let pi = null;
  let err = null;
  try {
    pi = await chargeOffSession({
      secretKey: creds.secretKey, stripeAccount: creds.stripeAccount,
      customerId: ag.stripe_customer_id, paymentMethodId: ag.payment_method_id,
      amountCents, currency: inv.currency || ag.currency || 'USD',
      description: `Invoice ${inv.number} (automatic payment)`,
      metadata: {
        invoice_id: inv.id, invoice_number: inv.number, workspace_id: workspaceId,
        client_id: inv.client_id, recurring_invoice_id: inv.recurring_invoice_id,
        autopay_agreement_id: ag.id, source: 'autopay', attempt,
      },
      idempotencyKey: idemKey(inv.id, attempt),
    });
  } catch (e) {
    err = e;
  }
  return handleChargeOutcome({ inv, ag, creds, pi, err, attempt });
}

async function handleChargeOutcome({ inv, ag, creds, pi, err, attempt }) {
  const workspaceId = inv.workspace_id;
  if (pi && pi.status === 'succeeded') {
    await sql`
      UPDATE invoices SET autopay_status = 'succeeded', autopay_payment_intent = ${pi.id},
             activity = activity || ${appendActivity(`Paid automatically with ${cardLong(ag.card_brand, ag.card_last4)}`)}::jsonb,
             updated_at = NOW()
       WHERE id = ${inv.id} AND workspace_id = ${workspaceId} AND autopay_status IN ('charging', 'processing')
    `;
    // Same path as every card payment: idempotent, notifies once, receipt
    // reads the autopay card off the invoice.
    const result = await fulfillInvoicePaymentIntent({ workspaceId, pi, creds, method: 'card' });
    return { outcome: 'succeeded', result, paymentIntentId: pi.id };
  }
  if (pi && pi.status === 'processing') {
    await sql`
      UPDATE invoices SET autopay_status = 'processing', autopay_payment_intent = ${pi.id}, updated_at = NOW()
       WHERE id = ${inv.id} AND workspace_id = ${workspaceId} AND autopay_status = 'charging'
    `;
    await markInvoiceProcessing({ workspaceId, invoiceId: inv.id, session: { id: null, payment_intent: pi.id, amount_total: pi.amount, payment_method_types: ['card'] } });
    return { outcome: 'processing', paymentIntentId: pi.id };
  }
  let failure;
  if (pi) {
    // 200 with a status that is not money: the bank wants the client.
    failure = { kind: 'failed', code: pi.status === 'requires_action' ? 'authentication_required' : 'card_declined', retryable: false };
  } else {
    failure = classifyChargeError(err);
  }
  if (failure.kind === 'unknown') {
    // Leave it 'charging'; the sweep asks Stripe again with the same key.
    return { outcome: 'unknown' };
  }
  return recordFailure({ inv, ag, attempt, code: failure.code, retryable: failure.retryable, paymentIntentId: err?.paymentIntentId || pi?.id || null });
}

async function recordFailure({ inv, ag, attempt, code, retryable, paymentIntentId }) {
  const workspaceId = inv.workspace_id;
  const willRetry = retryable && attempt < AUTOPAY_MAX_ATTEMPTS;
  const card = cardLong(ag.card_brand, ag.card_last4);
  const upd = await sql`
    UPDATE invoices SET
      autopay_status = ${willRetry ? 'retry_scheduled' : 'failed'},
      autopay_retry_at = ${willRetry ? new Date(Date.now() + AUTOPAY_RETRY_DAYS * 86400000).toISOString() : null},
      autopay_failed_at = NOW(),
      autopay_failure_code = ${code},
      autopay_failure_reason = ${failureWords(code)},
      autopay_payment_intent = COALESCE(${paymentIntentId}, autopay_payment_intent),
      activity = activity || ${appendActivity(`Automatic payment with ${card} failed: ${failureWords(code)}${willRetry ? `. Will try once more in ${AUTOPAY_RETRY_DAYS} days.` : ''}`)}::jsonb,
      updated_at = NOW()
    WHERE id = ${inv.id} AND workspace_id = ${workspaceId} AND autopay_status = 'charging'
    RETURNING *
  `;
  const row = upd.rows[0] || inv;
  // Tell the client with a working pay link.
  let emailed = false;
  if (row.client_email) {
    try {
      emailed = await sendFailureEmail({ inv: row, card, willRetry, retryAt: row.autopay_retry_at, attempt });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[autopay] failure email failed:', e.message);
    }
  }
  const when = willRetry ? ` Ivy will try once more on ${fmtDay(row.autopay_retry_at, { year: false })}.` : '';
  notifyOwnerSafe({
    workspaceId, type: 'payments',
    payload: {
      title: 'Autopay failed',
      body: `${row.client_name || 'Client'} · ${row.number}: ${failureWords(code)}. ${emailed ? 'We emailed them the invoice to pay.' : 'Send them the invoice to pay.'}${when}`,
      url: `/finance?invoice=${row.id}`,
      tag: `autopay-failed-${row.id}-${attempt}`,
    },
  });
  return { outcome: 'failed', code, willRetry, emailed };
}

// Mint a fresh pay link (the hash replaces any earlier one, like the
// overdue reminder does) and email the invoice with a friendly note.
async function sendFailureEmail({ inv, card, willRetry, retryAt, attempt }) {
  const raw = generateRawToken(32);
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const minted = await sql`
    UPDATE invoices SET view_token_hash = ${hash},
           status = CASE WHEN status = 'draft' THEN 'sent' ELSE status END,
           sent_at = COALESCE(sent_at, NOW()),
           updated_at = NOW()
     WHERE id = ${inv.id} AND workspace_id = ${inv.workspace_id}
       AND status IN ('draft', 'sent', 'overdue') AND payment_processing_at IS NULL
     RETURNING *
  `;
  const row = minted.rows[0];
  if (!row) return false;
  const link = `${appUrl()}/invoice/${encodeURIComponent(raw)}`;
  const branding = await fetchBranding(inv.workspace_id);
  const biz = branding.businessName || '';
  const amount = fmtAmount(balanceDueCents(row), row.currency);
  const note = attempt > 1
    ? `We tried your ${escapeHtml(card)} again and it still didn't go through.`
    : `We couldn't charge your ${escapeHtml(card)} for this invoice.`;
  const retryLine = willRetry && retryAt
    ? `<p>If it is still unpaid, we will try your card once more on ${escapeHtml(fmtDay(retryAt))}. Paying now with the button below means we won't.</p>`
    : '<p>Please pay with the button below. You can use the same card or a different one.</p>';
  const r = await sendEmailToClient({
    clientId: row.client_id, type: 'receipts', to: row.client_email,
    subject: `We couldn't charge your card · Invoice ${row.number}${biz ? ' from ' + biz : ''} · ${amount}`,
    replyTo: branding.replyTo,
    html: emailShell({
      heading: `Invoice ${row.number}`,
      branding,
      body: `<p>Hi ${escapeHtml(firstName(row.client_name))},</p>
        <p>${note} Nothing was charged. Banks decline for lots of everyday reasons, so no worries.</p>
        <p>Amount due: <b>${escapeHtml(amount)}</b>${row.due_date ? `, due ${escapeHtml(fmtDay(row.due_date))}` : ''}.</p>
        ${retryLine}`,
      ctaText: 'Pay invoice',
      ctaUrl: link,
      footer: 'You can update your card or turn off automatic payments in your client portal under Payments.',
    }),
  });
  if (row.client_id) {
    notifyClientSafe({
      clientId: row.client_id, type: 'payments',
      payload: {
        title: "We couldn't charge your card",
        body: `${biz || 'Your provider'} · ${row.number} · ${amount}. Tap to pay.`,
        url: '/me/invoices',
        tag: `autopay-failed-client-${row.id}`,
      },
    });
  }
  return !!r?.sent;
}

// Scheduled retries + recovery of charges whose answer we never got.
// Runs from the recurring cron after the materialize loop.
export async function runAutopaySweep({ deadline = Date.now() + 60000, limit = 100 } = {}) {
  const stats = { retried: 0, recovered: 0, gaveUp: 0, ended: 0 };
  stats.ended = await endOrphanedAgreements().catch(() => 0);

  const due = await sql`
    SELECT id, workspace_id FROM invoices
     WHERE autopay_status = 'retry_scheduled' AND autopay_retry_at <= NOW()
       AND status IN ('sent', 'overdue')
     ORDER BY autopay_retry_at ASC
     LIMIT ${limit}
  `;
  for (const r of due.rows) {
    if (Date.now() >= deadline) break;
    try {
      // eslint-disable-next-line no-await-in-loop
      const out = await chargeInvoiceAutopay({ workspaceId: r.workspace_id, invoiceId: r.id, retry: true });
      if (out.outcome === 'skipped' || out.outcome === 'no_consent' || out.outcome === 'waiting') {
        // The approval is gone or no longer fits: no retry, say so once.
        // eslint-disable-next-line no-await-in-loop
        await sql`
          UPDATE invoices SET autopay_status = 'failed', autopay_retry_at = NULL, updated_at = NOW(),
                 activity = activity || ${appendActivity('Automatic retry cancelled: autopay is no longer approved for this card.')}::jsonb
           WHERE id = ${r.id} AND workspace_id = ${r.workspace_id} AND autopay_status = 'retry_scheduled'
        `;
      } else {
        stats.retried += 1;
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[autopay] retry failed:', e.message);
    }
  }

  // Lost answers: same attempt, same idempotency key, same amount.
  const stuck = await sql`
    SELECT id, workspace_id FROM invoices
     WHERE autopay_status = 'charging'
       AND autopay_last_attempt_at < NOW() - (${String(RECOVERY_AFTER_MINUTES)} || ' minutes')::interval
     LIMIT ${limit}
  `;
  for (const r of stuck.rows) {
    if (Date.now() >= deadline) break;
    try {
      // eslint-disable-next-line no-await-in-loop
      const out = await recoverCharge(r);
      if (out === 'gave_up') stats.gaveUp += 1; else if (out) stats.recovered += 1;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[autopay] recovery failed:', e.message);
    }
  }
  return stats;
}

async function recoverCharge({ id, workspace_id: workspaceId }) {
  const claim = await sql`
    UPDATE invoices SET autopay_last_attempt_at = NOW(), updated_at = NOW()
     WHERE id = ${id} AND workspace_id = ${workspaceId} AND autopay_status = 'charging'
       AND autopay_last_attempt_at < NOW() - (${String(RECOVERY_AFTER_MINUTES)} || ' minutes')::interval
     RETURNING *
  `;
  const inv = claim.rows[0];
  if (!inv) return null;
  // Already settled by the webhook while we were not looking.
  if (inv.status === 'paid' || inv.status === 'refunded') {
    await sql`UPDATE invoices SET autopay_status = 'succeeded' WHERE id = ${id} AND workspace_id = ${workspaceId} AND autopay_status = 'charging'`;
    return 'settled';
  }
  const ag = inv.autopay_agreement_id
    ? (await sql`SELECT * FROM autopay_agreements WHERE id = ${inv.autopay_agreement_id} AND workspace_id = ${workspaceId}`).rows[0]
    : null;
  const ageHours = (Date.now() - new Date(inv.autopay_claimed_at || inv.autopay_last_attempt_at).getTime()) / 3600000;
  if (!ag || !inv.autopay_amount_cents || ageHours > RECOVERY_GIVE_UP_HOURS) {
    await sql`
      UPDATE invoices SET autopay_status = 'failed', autopay_failed_at = NOW(), autopay_failure_code = 'needs_check',
             autopay_failure_reason = ${failureWords('needs_check')}, updated_at = NOW()
       WHERE id = ${id} AND workspace_id = ${workspaceId} AND autopay_status = 'charging'
    `;
    notifyOwnerSafe({
      workspaceId, type: 'payments',
      payload: {
        title: 'Check an automatic payment',
        body: `${inv.number}: Stripe did not confirm the automatic payment. Check your Stripe payments before sending it again.`,
        url: `/finance?invoice=${id}`,
        tag: `autopay-check-${id}`,
      },
    });
    return 'gave_up';
  }
  let creds;
  try { creds = await loadStripeCreds(workspaceId); } catch { return null; }
  // Same attempt number and amount -> same Idempotency-Key and params ->
  // Stripe replays the original answer; it cannot charge twice.
  return runCharge({ inv, ag, creds, amountCents: Number(inv.autopay_amount_cents), attempt: inv.autopay_attempts });
}
