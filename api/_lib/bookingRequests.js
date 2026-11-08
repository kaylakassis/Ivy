// Booking requests ("confirm before it's final"), 1.0.6.
//
// A service with services.require_approval makes every booking made from
// the public page a REQUEST. The request is an ordinary bookings row that
// HOLDS the slot (cancelled_at IS NULL, so hasConflict and the public slot
// grid treat the time as taken) with requested_at set and
// request_decided_at NULL. It stays pending until:
//   • the owner (or a helper with the schedule permission) approves it:
//     request_decision 'approved', the client gets the normal confirmation,
//     reminders start, Google sync runs;
//   • it is declined ('declined'), the hold runs out ('expired') or the
//     client withdraws it ('cancelled'): cancelled_at is set, which releases
//     the slot, and the client is told.
//
// Money: nothing is charged when a request is made. A deposit is only taken
// at approval, from the card the client saved on the request (Stripe setup
// mode, nothing charged then), with an idempotency key per booking, amount
// and card so a retry can never charge twice. Without a saved card the
// approval sends a pay link instead.
//
// Pending requests are NOT appointments yet: reminders, no-shows, fees,
// revenue and Google Calendar all skip them through the SQL fragments below.
//
// Everything here is a plain function (no req/res) so the public booking
// route, the owner endpoints, Ivy's tools, the cron and the shop booking
// flow all share one implementation.
import { sql } from './db.js';
import { notifyOwnerSafe, notifyClientSafe } from './push.js';
import { sendEmailToClient, sendEmailToUser, emailShell } from './email.js';
import { fetchBranding } from './branding.js';
import { appUrl } from './tokens.js';
import { keepAlive } from './keepAlive.js';
import { sendClientSms } from './sms.js';
import { loadStripeCreds } from './stripeCreds.js';
import { chargeOffSession, createSetupCheckoutSession } from './stripe.js';
import { ensureStripeCustomer } from './savedCards.js';
import { fetchFinanceSettings } from './finance.js';
import { getProvider } from './payments/index.js';
import { restoreCredit } from './packages.js';
import { restoreGiftCardCreditForBooking } from './giftCards.js';
import { notifyNewBooking } from './bookingNotify.js';
import { syncOnBookingCreated } from './googleSync.js';
import { attachIntakeForms } from './intake.js';

export const HOLD_HOURS_OPTIONS = [12, 24, 48];
export const DEFAULT_HOLD_HOURS = 24;
export const REQUEST_MESSAGE_MAX = 500;

// SQL fragments. `a` is the bookings alias in the caller's query.
export const PENDING_REQUEST_SQL = (a = 'b') =>
  `(${a}.requested_at IS NOT NULL AND ${a}.request_decided_at IS NULL AND ${a}.cancelled_at IS NULL)`;
export const NOT_PENDING_SQL = (a = 'b') =>
  `(${a}.requested_at IS NULL OR ${a}.request_decided_at IS NOT NULL)`;

export function isPendingRequest(row) {
  return !!(row && row.requested_at && !row.request_decided_at && !row.cancelled_at);
}

// 'cancelled' | 'requested' | 'confirmed'
export function bookingStatus(row) {
  if (!row) return null;
  if (row.cancelled_at) return 'cancelled';
  if (isPendingRequest(row)) return 'requested';
  return 'confirmed';
}

export function serviceRequiresApproval(svc) {
  return !!(svc && (svc.require_approval ?? svc.requireApproval));
}

export function requestHoldHours(settingsRow) {
  const n = Number(settingsRow?.request_hold_hours);
  return HOLD_HOURS_OPTIONS.includes(n) ? n : DEFAULT_HOLD_HOURS;
}

// The columns a new booking row needs to be a request, or null when the
// service books straight away. Shared by the public booking route and the
// shop flow so they insert the same thing.
export function requestFieldsFor({ service, settingsRow, now = new Date() }) {
  if (!serviceRequiresApproval(service)) return null;
  const hours = requestHoldHours(settingsRow);
  return {
    requestedAt: now,
    requestExpiresAt: new Date(now.getTime() + hours * 3_600_000),
    holdHours: hours,
  };
}

const isoDate = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d || '').slice(0, 10));
function fmtDay(iso) {
  const d = new Date(`${isoDate(iso)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return isoDate(iso);
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
}
function fmtTime(min) {
  const h = Math.floor(Number(min) / 60), m = Number(min) % 60;
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h >= 12 ? 'pm' : 'am'}`;
}
function fmtStamp(ts, tz) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: tz || 'UTC', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    }).format(new Date(ts));
  } catch {
    return new Date(ts).toISOString();
  }
}
const first = (name) => (String(name || '').trim().split(/\s+/)[0] || 'there');
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtMoney(n, currency = 'USD') {
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(Number(n || 0)); }
  catch { return `$${Number(n || 0).toFixed(2)}`; }
}

export function cleanRequestMessage(v) {
  if (v == null) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, REQUEST_MESSAGE_MAX) : null;
}

// Everything the request flows need about one booking, in one read.
export async function loadRequestContext({ workspaceId, bookingId }) {
  const { rows } = await sql`
    SELECT b.*,
           s.name AS service_name, s.price AS service_price,
           c.name AS c_name, c.email AS c_email, c.phone AS c_phone, c.sms_consent_at,
           c.stripe_customer_id, c.payment_method_id, c.payment_method_last4, c.user_id AS client_user_id,
           cs.biz_name, cs.slug, cs.timezone,
           w.owner_id, u.email AS owner_email, u.name AS owner_name,
           COALESCE(fs.currency, 'USD') AS currency
      FROM bookings b
      LEFT JOIN services s ON s.id = b.service_id AND s.workspace_id = b.workspace_id
      LEFT JOIN clients c ON c.id = b.client_id AND c.workspace_id = b.workspace_id
      LEFT JOIN calendar_settings cs ON cs.workspace_id = b.workspace_id
      LEFT JOIN workspaces w ON w.id = b.workspace_id
      LEFT JOIN users u ON u.id = w.owner_id
      LEFT JOIN finance_settings fs ON fs.workspace_id = b.workspace_id
     WHERE b.id = ${bookingId} AND b.workspace_id = ${workspaceId}
     LIMIT 1`;
  return rows[0] || null;
}

function bookAgainUrl(ctx) {
  const base = appUrl();
  if (!ctx?.slug) return `${base}/me/bookings`;
  const svc = ctx.service_id ? `?service=${encodeURIComponent(ctx.service_id)}` : '';
  return `${base}/book/${encodeURIComponent(ctx.slug)}${svc}`;
}

// ── request made ─────────────────────────────────────────────────────────

// Card for the deposit, saved now and charged only at approval (Stripe
// Checkout in setup mode: nothing is charged). Only when the business takes
// cards through Stripe and the client has no card on file yet. Returns the
// page URL or null.
export async function depositCardSetupForRequest({ workspaceId, clientId, bookingId, successUrl, cancelUrl }) {
  if (!workspaceId || !clientId) return null;
  try {
    const fs = await fetchFinanceSettings(workspaceId);
    if (!fs || (fs.paymentProvider || 'stripe') !== 'stripe') return null;
    if (!(fs.stripeConnectUserId || fs.stripeSecretEncrypted)) return null;
    const { rows } = await sql`
      SELECT id, workspace_id, email, name, stripe_customer_id, payment_method_id
        FROM clients WHERE id = ${clientId} AND workspace_id = ${workspaceId} LIMIT 1`;
    const client = rows[0];
    if (!client?.email || client.payment_method_id) return null;
    const creds = await loadStripeCreds(workspaceId);
    const customerId = await ensureStripeCustomer({ creds, client });
    if (!customerId) return null;
    const s = await createSetupCheckoutSession({
      secretKey: creds.secretKey, stripeAccount: creds.stripeAccount,
      customerId, workspaceId, clientId, successUrl, cancelUrl,
    });
    if (s?.url && bookingId) {
      await sql`UPDATE bookings SET request_card_setup_at = NOW() WHERE id = ${bookingId} AND workspace_id = ${workspaceId}`.catch(() => {});
    }
    return s?.url || null;
  } catch (err) {
    console.warn('[booking request] card setup skipped:', err.message);
    return null;
  }
}

// Owner push + email for a new request. Fire and forget (keepAlive).
export function notifyOwnerOfRequest(args) {
  return keepAlive(notifyOwnerOfRequestImpl(args).catch((e) => console.error('[booking request] owner notify failed:', e?.message)));
}
async function notifyOwnerOfRequestImpl({ workspaceId, bookingId }) {
  const ctx = await loadRequestContext({ workspaceId, bookingId });
  if (!ctx || !isPendingRequest(ctx)) return;
  const who = first(ctx.client_name);
  const service = ctx.service_name || 'Session';
  const day = fmtDay(ctx.date);
  const time = fmtTime(ctx.start_min);
  const holdUntil = fmtStamp(ctx.request_expires_at, ctx.timezone);
  const url = `/calendar?request=${ctx.id}`;
  notifyOwnerSafe({
    workspaceId, type: 'bookings',
    payload: {
      title: `Booking request: ${who}, ${service}, ${day} at ${time}`,
      body: `The time is held until ${holdUntil}. Approve or decline from your calendar.`,
      url, tag: `request-${ctx.id}`,
    },
  });
  if (ctx.owner_email) {
    const branding = await fetchBranding(workspaceId).catch(() => null);
    const deposit = Number(ctx.deposit_required || 0);
    const html = emailShell({
      heading: `Booking request from ${escapeHtml(who)}`,
      branding,
      body: `<p>${ctx.owner_name ? `Hi ${escapeHtml(first(ctx.owner_name))},` : 'Hi,'}</p>
        <p><strong>${escapeHtml(ctx.client_name || 'A client')}</strong> asked to book <strong>${escapeHtml(service)}</strong>
        on <strong>${escapeHtml(day)}</strong> at <strong>${escapeHtml(time)}</strong>.</p>
        <p>The time is held for them until ${escapeHtml(holdUntil)}. If you do nothing by then, the request expires and they are told to pick another time.</p>
        ${deposit > 0 ? `<p>Their ${escapeHtml(fmtMoney(deposit, ctx.currency))} deposit is charged only when you approve.</p>` : ''}
        ${ctx.notes ? `<p><strong>Their note:</strong> ${escapeHtml(ctx.notes)}</p>` : ''}`,
      ctaText: 'Approve or decline',
      ctaUrl: `${appUrl()}${url}`,
    });
    await sendEmailToUser({
      userId: ctx.owner_id, type: 'bookings', to: ctx.owner_email,
      subject: `Booking request: ${who}, ${service}, ${day} at ${time}`, html,
    });
  }
}

// ── approve ──────────────────────────────────────────────────────────────

// Charge the deposit at approval, exactly once. Returns
//   { charged: dollars, paymentIntent } | { payUrl } | { error } | { none: true }
async function takeDepositAtApproval(ctx) {
  const due = Number(ctx.deposit_required || 0);
  if (!(due > 0) || ctx.deposit_paid_at || Number(ctx.deposit_paid || 0) >= due) return { none: true };
  const cents = Math.round(due * 100);
  const workspaceId = ctx.workspace_id;
  let error = null;
  if (ctx.stripe_customer_id && ctx.payment_method_id) {
    try {
      const creds = await loadStripeCreds(workspaceId);
      const pi = await chargeOffSession({
        secretKey: creds.secretKey, stripeAccount: creds.stripeAccount,
        customerId: ctx.stripe_customer_id, paymentMethodId: ctx.payment_method_id,
        amountCents: cents, currency: creds.currency || ctx.currency || 'USD',
        description: `Deposit · ${String(ctx.id).slice(0, 8)}`,
        metadata: { booking_id: ctx.id, workspace_id: workspaceId, kind: 'deposit', purpose: 'booking_request_deposit' },
        // One charge per booking, amount and card: a retry after a crash
        // gets the same charge back, never a second one.
        idempotencyKey: `reqdep-${ctx.id}-${cents}-${ctx.payment_method_id}`,
      });
      if (pi?.status === 'succeeded' || pi?.status === 'processing') {
        await sql`
          UPDATE bookings SET deposit_paid = ${due}, deposit_paid_at = NOW(), deposit_payment_intent = ${pi.id}, updated_at = NOW()
           WHERE id = ${ctx.id} AND workspace_id = ${workspaceId} AND deposit_paid_at IS NULL`;
        return { charged: due, paymentIntent: pi.id };
      }
      error = 'The card could not be charged.';
    } catch (err) {
      error = String(err?.message || 'The card could not be charged.').slice(0, 200);
    }
  }
  // No saved card, or the charge did not go through: a pay link instead.
  try {
    const { adapter, name, settings } = await getProvider(workspaceId);
    const base = appUrl();
    const session = await adapter.createCheckoutSession({
      workspaceId, settings,
      amountCents: cents,
      currency: (settings?.currency || 'usd').toUpperCase(),
      description: `Deposit · ${String(ctx.id).slice(0, 8)}`,
      metadata: { invoice_id: `bookdep_${ctx.id}`, booking_id: ctx.id, workspace_id: workspaceId, client_id: ctx.client_id },
      successUrl: `${base}/book/${encodeURIComponent(ctx.slug || '')}?deposit=paid`,
      cancelUrl: `${base}/book/${encodeURIComponent(ctx.slug || '')}?deposit=cancelled`,
      customerEmail: ctx.client_email,
    });
    if (session?.sessionId) {
      await sql`UPDATE bookings SET deposit_payment_intent = ${session.sessionId} WHERE id = ${ctx.id} AND workspace_id = ${workspaceId}`;
    }
    return { payUrl: session?.url || null, error, provider: name };
  } catch (err) {
    return { error: error || `No online payment is set up (${String(err?.message || '').slice(0, 120)})` };
  }
}

// The owner's Approve. Exactly once: the status flip is the claim.
export async function approveBookingRequest({ workspaceId, bookingId, userId = null, message = null, actor = 'owner' }) {
  const note = cleanRequestMessage(message);
  const flip = await sql`
    UPDATE bookings SET
      request_decided_at = NOW(), request_decision = 'approved',
      request_decided_by = ${userId}, request_message = ${note}, updated_at = NOW()
     WHERE id = ${bookingId} AND workspace_id = ${workspaceId}
       AND requested_at IS NOT NULL AND request_decided_at IS NULL AND cancelled_at IS NULL
     RETURNING id`;
  if (flip.rows.length === 0) {
    const cur = await sql`SELECT id, request_decision, cancelled_at FROM bookings WHERE id = ${bookingId} AND workspace_id = ${workspaceId}`;
    if (!cur.rows[0]) return { notFound: true };
    return { alreadyDecided: true, decision: cur.rows[0].request_decision || (cur.rows[0].cancelled_at ? 'cancelled' : null) };
  }
  const ctx = await loadRequestContext({ workspaceId, bookingId });
  const deposit = await takeDepositAtApproval(ctx);
  if (deposit.error && !deposit.payUrl) {
    notifyOwnerSafe({
      workspaceId, type: 'payments',
      payload: {
        title: 'Deposit not taken yet',
        body: `${ctx.client_name || 'Client'}: ${fmtMoney(ctx.deposit_required, ctx.currency)} for ${ctx.service_name || 'the session'} on ${fmtDay(ctx.date)}. ${deposit.error}`,
        url: `/calendar?booking=${ctx.id}`, tag: `reqdep-fail-${ctx.id}`,
      },
    });
  }
  // The normal "booking confirmed" side effects run now, not when the
  // request came in: confirmation email + text, thread note, milestones,
  // Google Calendar, intake forms. Reminders follow from the row itself.
  notifyNewBooking({ workspaceId, bookingId, source: 'request_approved', extraNote: note, depositPayUrl: deposit.payUrl || null })
    .catch((e) => console.error('[booking request] confirmation failed:', e?.message));
  syncOnBookingCreated({ workspaceId, bookingId })
    .catch((e) => console.error('[booking request] google sync failed:', e?.message));
  attachIntakeForms({ workspaceId, bookingId })
    .catch((e) => console.error('[booking request] intake forms failed:', e?.message));
  const fresh = await sql`SELECT * FROM bookings WHERE id = ${bookingId} AND workspace_id = ${workspaceId}`;
  return {
    ok: true, approved: true, actor, booking: fresh.rows[0] || null,
    deposit: {
      required: Number(ctx.deposit_required || 0),
      charged: Number(deposit.charged || 0),
      payUrlSent: !!deposit.payUrl,
      error: deposit.error || null,
    },
    clientNotified: !!(ctx.client_email),
  };
}

// ── decline / expire / withdraw ──────────────────────────────────────────

async function releaseHeld({ workspaceId, booking }) {
  // Nothing was charged for a request, so there is no deposit to settle.
  // A package session or gift card credit used when requesting goes back.
  await restoreCredit({ workspaceId, clientPackageId: booking.client_package_id }).catch(() => {});
  await restoreGiftCardCreditForBooking({ workspaceId, bookingId: booking.id })
    .catch((err) => console.error('[booking request] gift card restore failed:', err.message));
}

// reason: 'declined' (owner or helper) | 'expired' (the hold ran out).
export async function declineBookingRequest({ workspaceId, bookingId, userId = null, message = null, reason = 'declined' }) {
  const why = reason === 'expired' ? 'expired' : 'declined';
  const note = cleanRequestMessage(message);
  const flip = await sql`
    UPDATE bookings SET
      cancelled_at = NOW(), cancelled_by = ${why === 'expired' ? 'system' : 'owner'},
      request_decided_at = NOW(), request_decision = ${why},
      request_decided_by = ${userId}, request_message = ${note}, updated_at = NOW()
     WHERE id = ${bookingId} AND workspace_id = ${workspaceId}
       AND requested_at IS NOT NULL AND request_decided_at IS NULL AND cancelled_at IS NULL
     RETURNING *`;
  if (flip.rows.length === 0) {
    const cur = await sql`SELECT id, request_decision, cancelled_at FROM bookings WHERE id = ${bookingId} AND workspace_id = ${workspaceId}`;
    if (!cur.rows[0]) return { notFound: true };
    return { alreadyDecided: true, decision: cur.rows[0].request_decision || (cur.rows[0].cancelled_at ? 'cancelled' : null) };
  }
  const booking = flip.rows[0];
  await releaseHeld({ workspaceId, booking });
  keepAlive(tellClientNotAvailable({ workspaceId, bookingId, reason: why, note })
    .catch((e) => console.error('[booking request] client notice failed:', e?.message)));
  return { ok: true, declined: true, reason: why, booking, clientNotified: !!booking.client_email };
}

async function tellClientNotAvailable({ workspaceId, bookingId, reason, note }) {
  const ctx = await loadRequestContext({ workspaceId, bookingId });
  if (!ctx) return;
  const biz = ctx.biz_name || 'The business';
  const service = ctx.service_name || 'your session';
  const day = fmtDay(ctx.date);
  const time = fmtTime(ctx.start_min);
  const link = bookAgainUrl(ctx);
  const heading = reason === 'expired' ? `${biz} couldn't confirm in time` : "Sorry, that time isn't available";
  const lead = reason === 'expired'
    ? `${biz} couldn't confirm your request for ${service} on ${day} at ${time} in time, so the hold on that time has ended.`
    : `${biz} can't take your request for ${service} on ${day} at ${time}.`;
  if (ctx.client_email) {
    const branding = await fetchBranding(workspaceId).catch(() => null);
    const html = emailShell({
      heading, branding,
      body: `<p>Hi ${escapeHtml(first(ctx.client_name))},</p>
        <p>${escapeHtml(lead)}</p>
        ${note ? `<p style="margin:14px 0;padding:12px 14px;background:#F6F5F1;border:1px solid #E8E4DC;border-radius:10px;"><strong>A note from ${escapeHtml(biz)}:</strong><br/>${escapeHtml(note)}</p>` : ''}
        <p>Nothing was charged. Pick another time: <a href="${escapeHtml(link)}" style="color:#2E3168;">${escapeHtml(link)}</a></p>`,
      ctaText: 'Pick another time',
      ctaUrl: link,
      footer: `Questions? Reply to this email to reach ${escapeHtml(biz)}.`,
    });
    await sendEmailToClient({
      clientId: ctx.client_id, workspaceId, type: 'bookings', to: ctx.client_email,
      subject: reason === 'expired' ? `${biz} couldn't confirm your request` : `Sorry, that time isn't available`,
      html, replyTo: branding?.replyTo,
    });
  }
  const phone = ctx.client_phone || ctx.c_phone;
  if (phone && ctx.sms_consent_at) {
    await sendClientSms({
      phone, consentAt: ctx.sms_consent_at, workspaceId,
      body: reason === 'expired'
        ? `${biz}: we couldn't confirm your ${service} request for ${day} at ${time} in time. Pick another time: ${link}`
        : `${biz}: sorry, ${day} at ${time} isn't available for ${service}. Pick another time: ${link}`,
    }).catch(() => {});
  }
  if (ctx.client_id && ctx.client_user_id) {
    notifyClientSafe({
      clientId: ctx.client_id, type: 'bookings',
      payload: { title: heading, body: `${service} · ${day} at ${time}. Pick another time.`, url: '/me/bookings', tag: `request-${ctx.id}` },
    });
  }
}

// The client withdraws their own request from the portal. `clientIds` are
// the clients rows the signed-in user owns (ownership check lives here too).
export async function cancelBookingRequestByClient({ workspaceId, bookingId, clientIds }) {
  if (!Array.isArray(clientIds) || clientIds.length === 0) return { notFound: true };
  const flip = await sql.query(
    `UPDATE bookings SET
       cancelled_at = NOW(), cancelled_by = 'client',
       request_decided_at = NOW(), request_decision = 'cancelled', updated_at = NOW()
     WHERE id = $1 AND workspace_id = $2 AND client_id = ANY($3)
       AND requested_at IS NOT NULL AND request_decided_at IS NULL AND cancelled_at IS NULL
     RETURNING *`,
    [bookingId, workspaceId, clientIds],
  );
  if (flip.rows.length === 0) return { alreadyDecided: true };
  const booking = flip.rows[0];
  await releaseHeld({ workspaceId, booking });
  keepAlive((async () => {
    const ctx = await loadRequestContext({ workspaceId, bookingId });
    if (!ctx) return;
    const who = first(ctx.client_name);
    notifyOwnerSafe({
      workspaceId, type: 'bookings',
      payload: {
        title: `${who} withdrew their booking request`,
        body: `${ctx.service_name || 'Session'} · ${fmtDay(ctx.date)} at ${fmtTime(ctx.start_min)}. The time is open again.`,
        url: '/calendar', tag: `request-${ctx.id}`,
      },
    });
  })().catch((e) => console.error('[booking request] owner notice failed:', e?.message)));
  return { ok: true, cancelled: true, booking };
}

// Cron: every pending request whose hold has run out is declined as
// 'expired' (slot released, client told). Returns how many were expired.
export async function expireBookingRequests({ limit = 200 } = {}) {
  const { rows } = await sql`
    SELECT id, workspace_id FROM bookings
     WHERE requested_at IS NOT NULL AND request_decided_at IS NULL AND cancelled_at IS NULL
       AND request_expires_at < NOW()
     ORDER BY request_expires_at ASC
     LIMIT ${Math.max(1, Math.min(1000, limit))}`;
  let n = 0;
  for (const r of rows) {
    // eslint-disable-next-line no-await-in-loop
    const out = await declineBookingRequest({ workspaceId: r.workspace_id, bookingId: r.id, reason: 'expired' })
      .catch((e) => { console.error('[booking request] expire failed:', e.message); return null; });
    if (out?.ok) n += 1;
  }
  return n;
}

// ── reads ────────────────────────────────────────────────────────────────

export function serializeRequestRow(r) {
  return {
    id: r.id, clientId: r.client_id || null, clientName: r.client_name, clientEmail: r.client_email,
    serviceId: r.service_id || null, serviceName: r.service_name || null,
    date: isoDate(r.date), startMin: r.start_min, endMin: r.end_min,
    notes: r.notes || null,
    depositRequired: Number(r.deposit_required || 0),
    requestedAt: r.requested_at, requestExpiresAt: r.request_expires_at,
    status: 'requested', isRequest: true,
  };
}

export async function listOpenRequests(workspaceId, { limit = 50 } = {}) {
  const { rows } = await sql`
    SELECT b.id, b.client_id, b.client_name, b.client_email, b.service_id, b.date, b.start_min, b.end_min,
           b.notes, b.deposit_required, b.requested_at, b.request_expires_at, s.name AS service_name
      FROM bookings b
      LEFT JOIN services s ON s.id = b.service_id AND s.workspace_id = b.workspace_id
     WHERE b.workspace_id = ${workspaceId}
       AND b.requested_at IS NOT NULL AND b.request_decided_at IS NULL AND b.cancelled_at IS NULL
     ORDER BY b.requested_at ASC
     LIMIT ${Math.max(1, Math.min(200, limit))}`;
  return rows.map(serializeRequestRow);
}

// Plain words for Ivy and the dashboard.
export function requestLine(r) {
  return `${first(r.clientName)}, ${r.serviceName || 'Session'}, ${fmtDay(r.date)} at ${fmtTime(r.startMin)}`;
}
export { fmtDay as requestDay, fmtTime as requestTime, fmtStamp as requestStamp };
