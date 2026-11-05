// Booking money under the cancellation policy: deposits, late-cancellation
// fees and no-show fees. One module so the client portal cancel, the
// owner cancel, the no-show mark and the manual "Charge fee" button all
// apply the same rules.
//
// The rules (shown to clients on the booking page and the policy record):
//   • Client cancels BEFORE the service's cancellation window: no fee, and
//     when the policy refunds deposits, a refund REQUEST is opened for the
//     owner's one-tap approval (Refund / Keep deposit). Nothing is
//     refunded until the owner approves.
//   • Client cancels INSIDE the window: the deposit is kept and counts
//     toward the late-cancellation fee; only the rest of the fee (if any)
//     is charged to the card on file. A client is never charged more than
//     the fee they agreed to when they booked (lower of agreed and current).
//   • No-show (owner marks it): same, with the no-show fee.
//   • Package sessions: "used when booked" late cancel or no-show keeps the
//     session used and charges NO fee (never both); "used when completed"
//     releases the held session on cancel and the normal fee applies once.
//   • The business cancels: never a fee; the deposit goes back when the
//     owner says so (in the cancel itself, or from the refund request).
//
// Exactly once: a fee is guarded by a claim (bookings.fee_claimed_at) plus
// a "not already charged" condition, and the processor call carries an
// idempotency key built from booking + kind + amount + card, so a retry or
// a crash after the charge reuses the original charge. Deposit refunds use
// the same pattern (deposit_refund_claimed_at + a key per refunded total).
//
// When the card cannot be charged (no card on file, card declined, the
// bank asks for the client to confirm, no card processor), the owner is
// told and a DRAFT invoice for the fee is created once, so nothing is
// lost and nothing is sent to the client without the owner deciding.
import { sql } from './db.js';
import { slotEpochMs } from './calendar.js';
import { loadStripeCreds } from './stripeCreds.js';
import { chargeOffSession, createSetupCheckoutSession } from './stripe.js';
import { refundThroughProvider } from './refunds.js';
import { createDraftInvoice, fetchFinanceSettings } from './finance.js';
import { ensureStripeCustomer } from './savedCards.js';
import { notifyOwnerSafe } from './push.js';
import { sendEmailToClient, sendEmailToUser, emailShell } from './email.js';
import { fetchBranding } from './branding.js';
import { appUrl } from './tokens.js';
import { getPolicySettings, acceptedTermsForBooking, escapeHtml } from './cancellationPolicy.js';

const CLAIM_STALE = '10 minutes';
const KIND_LABEL = { late_cancel: 'late-cancellation fee', no_show: 'no-show fee' };

function fmtMoney(cents, currency = 'USD') {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(Number(cents || 0) / 100);
  } catch {
    return `$${(Number(cents || 0) / 100).toFixed(2)}`;
  }
}
const toCents = (n) => Math.max(0, Math.round(Number(n || 0) * 100));
const isoDate = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d || '').slice(0, 10));
function fmtTime(min) {
  const h = Math.floor(Number(min) / 60), m = Number(min) % 60;
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

export async function loadFeeContext({ workspaceId, bookingId }) {
  const { rows } = await sql`
    SELECT b.*,
           s.id AS svc_id, s.name AS service_name, s.cancellation_fee_amount,
           s.cancellation_window_hours, s.no_show_fee_amount,
           c.stripe_customer_id, c.payment_method_id, c.payment_method_last4,
           c.email AS c_email, c.name AS c_name,
           cs.timezone, cs.biz_name,
           COALESCE(fs.currency, 'USD') AS currency
      FROM bookings b
      LEFT JOIN services s ON s.id = b.service_id AND s.workspace_id = b.workspace_id
      LEFT JOIN clients c ON c.id = b.client_id AND c.workspace_id = b.workspace_id
      LEFT JOIN calendar_settings cs ON cs.workspace_id = b.workspace_id
      LEFT JOIN finance_settings fs ON fs.workspace_id = b.workspace_id
     WHERE b.id = ${bookingId} AND b.workspace_id = ${workspaceId}
     LIMIT 1
  `;
  return rows[0] || null;
}

// The fees that apply to this booking: the lower of what the client agreed
// to (acceptance record) and the service's current settings. With no
// service row left, the agreed terms alone.
export function effectiveTerms(ctx, accepted, settings) {
  const hasSvc = !!ctx?.svc_id;
  const cur = {
    lateFee: hasSvc ? Number(ctx.cancellation_fee_amount || 0) : null,
    windowHours: hasSvc ? (Number.isInteger(ctx.cancellation_window_hours) ? ctx.cancellation_window_hours : 24) : null,
    noShowFee: hasSvc ? Number(ctx.no_show_fee_amount || 0) : null,
  };
  const pick = (a, b) => {
    const okA = Number.isFinite(Number(a)) && a !== null && a !== undefined;
    const okB = Number.isFinite(Number(b)) && b !== null && b !== undefined;
    if (okA && okB) return Math.min(Number(a), Number(b));
    if (okA) return Number(a);
    if (okB) return Number(b);
    return 0;
  };
  return {
    lateFee: pick(cur.lateFee, accepted?.lateCancelFee),
    windowHours: pick(cur.windowHours, accepted?.cancellationWindowHours),
    noShowFee: pick(cur.noShowFee, accepted?.noShowFee),
    refundDepositOutsideWindow: settings ? settings.refundDepositOutsideWindow !== false : true,
  };
}

// Inside the window = the appointment starts less than windowHours from
// now, measured in the BUSINESS's time zone. A 0-hour window is never late.
export function isInsideWindow(ctx, windowHours, nowMs = Date.now()) {
  const h = Number(windowHours || 0);
  if (!(h > 0)) return false;
  const startMs = slotEpochMs(isoDate(ctx.date), Number(ctx.start_min), ctx.timezone || null);
  if (!Number.isFinite(startMs)) return false;
  return startMs < nowMs + h * 3_600_000;
}

// A package booking whose session counted as used when it was booked
// (calendar_settings.package_use_on 'booking', stamped on the booking as
// package_use_mode; older package bookings without a stamp are 'booking').
export function isPackageUsedWhenBooked(ctx) {
  return !!ctx?.client_package_id && ctx.package_use_mode !== 'completion';
}

export function depositHeldCents(ctx) {
  return Math.max(0, toCents(ctx.deposit_paid) - toCents(ctx.deposit_refunded_amount));
}

// ── Notifications ──────────────────────────────────────────────────────
async function emailClient(ctx, { subject, heading, lines, note }) {
  const to = ctx.c_email || ctx.client_email;
  if (!to) return;
  try {
    const branding = await fetchBranding(ctx.workspace_id);
    const biz = ctx.biz_name || 'the business';
    const first = String(ctx.c_name || ctx.client_name || '').trim().split(/\s+/)[0];
    const rows = lines.map(([k, v]) => `<tr><td style="padding:6px 16px 6px 0;color:#85827B;">${escapeHtml(k)}</td><td style="padding:6px 0;font-weight:600;">${escapeHtml(v)}</td></tr>`).join('');
    const html = emailShell({
      heading, branding,
      body: `<p>${first ? `Hi ${escapeHtml(first)},` : 'Hi,'}</p>
        <p>${escapeHtml(note)}</p>
        <table role="presentation" cellpadding="0" cellspacing="0" style="margin:18px 0;border-collapse:collapse;font-size:14px;line-height:1.55;">${rows}</table>`,
      ctaText: 'See your bookings',
      ctaUrl: `${appUrl()}/me/bookings`,
      footer: `Questions? Reply to this email to reach ${escapeHtml(biz)}.`,
    });
    await sendEmailToClient({
      clientId: ctx.client_id, workspaceId: ctx.workspace_id, type: 'receipts',
      to, subject, html, replyTo: branding?.replyTo,
    });
  } catch (err) {
    console.warn('[bookingFees] client email failed:', err.message);
  }
}

async function emailOwner(ctx, { subject, heading, text, ctaUrl = null }) {
  try {
    const { rows } = await sql`
      SELECT u.id, u.email FROM workspaces w JOIN users u ON u.id = w.owner_id WHERE w.id = ${ctx.workspace_id}
    `;
    const owner = rows[0];
    if (!owner?.email) return;
    const html = emailShell({
      heading,
      body: `<p>${escapeHtml(text)}</p>`,
      ctaText: ctaUrl ? 'Review it' : 'Open the calendar',
      ctaUrl: ctaUrl || `${appUrl()}/calendar`,
    });
    await sendEmailToUser({ userId: owner.id, type: 'bookings', to: owner.email, subject, html });
  } catch (err) {
    console.warn('[bookingFees] owner email failed:', err.message);
  }
}

function apptLabel(ctx) {
  return `${ctx.service_name || 'Session'} on ${isoDate(ctx.date)} at ${fmtTime(ctx.start_min)}`;
}

// ── Fee charge (exactly once) ──────────────────────────────────────────
//
// dueCents: what goes on the card. fromDepositCents: the part of the fee
// the kept deposit already covers. Returns
//   { charged: cents, fromDeposit: cents, paymentIntent?, error?, invoice?, deduped? }
export async function chargeFee({ ctx, kind, dueCents, fromDepositCents = 0 }) {
  const workspaceId = ctx.workspace_id;
  const id = ctx.id;
  const claim = await sql`
    UPDATE bookings SET fee_claimed_at = NOW()
     WHERE id = ${id} AND workspace_id = ${workspaceId}
       AND fee_charged_kind IS NULL AND COALESCE(fee_charged_amount, 0) = 0
       AND (fee_claimed_at IS NULL OR fee_claimed_at < NOW() - ${CLAIM_STALE}::interval)
    RETURNING id
  `;
  if (claim.rows.length === 0) return { charged: 0, fromDeposit: 0, deduped: true };
  const currency = String(ctx.currency || 'USD').toUpperCase();
  const label = KIND_LABEL[kind] || 'fee';
  const fromDep = Math.max(0, Math.round(fromDepositCents));
  const due = Math.max(0, Math.round(dueCents));

  // Fully covered by the deposit the business keeps: nothing to charge.
  if (due === 0) {
    await sql`
      UPDATE bookings SET
        fee_charged_kind = ${kind}, fee_charged_at = NOW(), fee_charged_amount = 0,
        fee_from_deposit_amount = ${fromDep / 100}, fee_claimed_at = NULL, fee_charge_error = NULL,
        updated_at = NOW()
      WHERE id = ${id} AND workspace_id = ${workspaceId}
    `;
    if (fromDep > 0) {
      notifyOwnerSafe({
        workspaceId, type: 'payments',
        payload: { title: `${label[0].toUpperCase()}${label.slice(1)} covered by the deposit`,
          body: `${ctx.client_name || 'Client'}: ${fmtMoney(fromDep, currency)} deposit kept for ${apptLabel(ctx)}.`,
          url: '/calendar', tag: `fee-${id}` },
      });
    }
    return { charged: 0, fromDeposit: fromDep };
  }

  let error = null;
  let pi = null;
  if (!ctx.stripe_customer_id || !ctx.payment_method_id) {
    error = 'No card on file for this client.';
  } else {
    try {
      const creds = await loadStripeCreds(workspaceId);
      pi = await chargeOffSession({
        secretKey: creds.secretKey,
        stripeAccount: creds.stripeAccount,
        customerId: ctx.stripe_customer_id,
        paymentMethodId: ctx.payment_method_id,
        amountCents: due,
        currency: creds.currency || currency,
        description: `${label[0].toUpperCase()}${label.slice(1)} - ${ctx.service_name || 'session'}`,
        metadata: { booking_id: id, workspace_id: workspaceId, kind },
        statementDescriptor: kind === 'late_cancel' ? 'LATE CANCEL FEE' : 'NO-SHOW FEE',
        // One charge per booking + kind + amount + card. A retry or a crash
        // after the charge returns the original charge; a NEW card (the
        // client updated theirs) gets a fresh key instead of the cached
        // decline of the old one.
        idempotencyKey: `fee-${id}-${kind}-${due}-${ctx.payment_method_id}`,
      });
      if (pi?.status !== 'succeeded' && pi?.status !== 'processing') {
        error = pi?.status === 'requires_action' || pi?.status === 'requires_confirmation'
          ? "The client's bank asked them to confirm this charge, so it could not go through automatically."
          : 'The card could not be charged.';
        pi = null;
      }
    } catch (err) {
      error = err.code === 'no_stripe_connection' || /not connected|no_stripe/i.test(err.message || '')
        ? 'Card payments are not connected, so the fee could not be charged automatically.'
        : (err.stripeCode === 'authentication_required' || /authentication/i.test(err.message || ''))
          ? "The client's bank asked them to confirm this charge, so it could not go through automatically."
          : `The card was declined${err.message ? `: ${String(err.message).slice(0, 160)}` : '.'}`;
    }
  }

  if (pi) {
    await sql`
      UPDATE bookings SET
        fee_charged_amount = ${due / 100}, fee_charged_at = NOW(), fee_charged_kind = ${kind},
        fee_payment_intent = ${pi.id}, fee_from_deposit_amount = ${fromDep / 100},
        fee_claimed_at = NULL, fee_charge_error = NULL, updated_at = NOW()
      WHERE id = ${id} AND workspace_id = ${workspaceId}
    `;
    // A draft invoice from an earlier failed attempt is now moot. Only a
    // DRAFT (never sent) is voided; anything the client already has stays.
    if (ctx.fee_invoice_id) {
      await sql`
        UPDATE invoices SET status = 'voided', updated_at = NOW()
         WHERE id = ${ctx.fee_invoice_id} AND workspace_id = ${workspaceId} AND status = 'draft'
      `.catch(() => {});
    }
    const lines = [['Appointment', apptLabel(ctx)], ['Charged to your card', `${fmtMoney(due, currency)}${ctx.payment_method_last4 ? ` (card ending ${ctx.payment_method_last4})` : ''}`]];
    if (fromDep > 0) lines.splice(1, 0, ['Covered by your deposit', fmtMoney(fromDep, currency)]);
    await emailClient(ctx, {
      subject: `Receipt: ${label} from ${ctx.biz_name || 'your booking'}`,
      heading: `Receipt for your ${label}`,
      note: `This charge follows the cancellation policy for your booking with ${ctx.biz_name || 'the business'}.`,
      lines,
    });
    notifyOwnerSafe({
      workspaceId, type: 'payments',
      payload: { title: `${label[0].toUpperCase()}${label.slice(1)} charged`,
        body: `${ctx.client_name || 'Client'}: ${fmtMoney(due, currency)} charged${fromDep > 0 ? ` (plus ${fmtMoney(fromDep, currency)} deposit kept)` : ''} for ${apptLabel(ctx)}.`,
        url: '/calendar', tag: `fee-${id}` },
    });
    return { charged: due, fromDeposit: fromDep, paymentIntent: pi.id };
  }

  // Could not charge: one draft invoice for the fee (never a second one),
  // then release the claim so the owner can retry with "Charge fee".
  let invoice = null;
  if (!ctx.fee_invoice_id) {
    try {
      invoice = await createDraftInvoice({
        workspaceId, clientId: ctx.client_id || null,
        clientName: ctx.client_name || ctx.c_name || null,
        clientEmail: ctx.client_email || ctx.c_email || null,
        items: [{ description: `${label[0].toUpperCase()}${label.slice(1)}: ${apptLabel(ctx)}`, quantity: 1, rate: due / 100 }],
        taxRate: 0,
        notes: `Per the cancellation policy for this booking.${fromDep > 0 ? ` ${fmtMoney(fromDep, currency)} of the fee was covered by the kept deposit.` : ''}`,
        dueInDays: 7,
      });
    } catch (err) {
      console.error('[bookingFees] draft invoice failed:', err.message);
    }
  }
  await sql`
    UPDATE bookings SET
      fee_claimed_at = NULL, fee_charge_error = ${error},
      fee_from_deposit_amount = ${fromDep / 100},
      fee_invoice_id = COALESCE(fee_invoice_id, ${invoice?.id || null}),
      updated_at = NOW()
    WHERE id = ${id} AND workspace_id = ${workspaceId}
  `;
  const inv = invoice?.number ? ` A draft invoice (${invoice.number}) is ready for you to send.` : '';
  notifyOwnerSafe({
    workspaceId, type: 'payments',
    payload: { title: `Could not charge the ${label}`,
      body: `${ctx.client_name || 'Client'}: ${fmtMoney(due, currency)} for ${apptLabel(ctx)}. ${error}${inv}`,
      url: '/calendar', tag: `fee-fail-${id}` },
  });
  await emailOwner(ctx, {
    subject: `Could not charge the ${label} for ${ctx.client_name || 'a client'}`,
    heading: `The ${label} did not go through`,
    text: `${ctx.client_name || 'Your client'} owes ${fmtMoney(due, currency)} for ${apptLabel(ctx)} under your cancellation policy. ${error}${inv} You can also try again from the booking with "Charge fee" once they update their card.`,
  });
  return { charged: 0, fromDeposit: fromDep, error, invoice: invoice ? { id: invoice.id, number: invoice.number } : null };
}

// ── Deposit refund (exactly once per refunded total) ───────────────────
export async function refundDeposit({ ctx, amountCents = null, reason = 'requested_by_customer', who = 'policy' }) {
  const workspaceId = ctx.workspace_id;
  const held = depositHeldCents(ctx);
  const amount = amountCents == null ? held : Math.min(held, Math.max(0, Math.round(amountCents)));
  if (amount <= 0 || !ctx.deposit_payment_intent || !ctx.deposit_paid_at) return { refunded: 0 };
  const already = toCents(ctx.deposit_refunded_amount);
  const claim = await sql`
    UPDATE bookings SET deposit_refund_claimed_at = NOW()
     WHERE id = ${ctx.id} AND workspace_id = ${workspaceId}
       AND ROUND(COALESCE(deposit_refunded_amount, 0) * 100) = ${already}
       AND (deposit_refund_claimed_at IS NULL OR deposit_refund_claimed_at < NOW() - ${CLAIM_STALE}::interval)
    RETURNING id
  `;
  if (claim.rows.length === 0) return { refunded: 0, deduped: true };
  const currency = String(ctx.currency || 'USD').toUpperCase();
  try {
    const out = await refundThroughProvider({
      workspaceId, paymentIntent: ctx.deposit_payment_intent,
      amountCents: amount, reason,
      idempotencyKey: `deprefund-${ctx.id}-${already}`,
    });
    await sql`
      UPDATE bookings SET
        -- Set (not add): the processor's charge.refunded echo may already
        -- have recorded this same refund (checkoutFulfillment.js).
        deposit_refunded_amount = GREATEST(COALESCE(deposit_refunded_amount, 0), ${(already + amount) / 100}),
        deposit_refunded_at = NOW(), deposit_refund_id = ${out?.id || null},
        deposit_refund_claimed_at = NULL, deposit_refund_error = NULL,
        deposit_refund_request_status = CASE WHEN deposit_refund_request_status = 'pending' THEN 'approved'
                                             ELSE deposit_refund_request_status END,
        deposit_refund_decided_at = COALESCE(deposit_refund_decided_at, NOW()),
        updated_at = NOW()
      WHERE id = ${ctx.id} AND workspace_id = ${workspaceId}
    `;
    await emailClient(ctx, {
      subject: `Your ${fmtMoney(amount, currency)} deposit was refunded`,
      heading: 'Your deposit is on its way back',
      note: who === 'owner'
        ? `${ctx.biz_name || 'The business'} refunded your deposit. Refunds usually show on your statement within 5 to 10 business days.`
        : `You cancelled before the cancellation window, so your deposit was refunded. Refunds usually show on your statement within 5 to 10 business days.`,
      lines: [['Appointment', apptLabel(ctx)], ['Refunded', fmtMoney(amount, currency)]],
    });
    notifyOwnerSafe({
      workspaceId, type: 'payments',
      payload: { title: 'Deposit refunded', body: `${ctx.client_name || 'Client'}: ${fmtMoney(amount, currency)} back for ${apptLabel(ctx)}.`,
        url: '/calendar', tag: `deprefund-${ctx.id}` },
    });
    return { refunded: amount, refundId: out?.id || null };
  } catch (err) {
    const msg = String(err.message || 'The refund did not go through.').slice(0, 300);
    await sql`
      UPDATE bookings SET deposit_refund_claimed_at = NULL, deposit_refund_error = ${msg}, updated_at = NOW()
      WHERE id = ${ctx.id} AND workspace_id = ${workspaceId}
    `.catch(() => {});
    notifyOwnerSafe({
      workspaceId, type: 'payments',
      payload: { title: 'Deposit refund did not go through',
        body: `${ctx.client_name || 'Client'}: ${fmtMoney(amount, currency)} for ${apptLabel(ctx)}. ${msg}`,
        url: '/calendar', tag: `deprefund-fail-${ctx.id}` },
    });
    await emailOwner(ctx, {
      subject: `Refund the ${fmtMoney(amount, currency)} deposit for ${ctx.client_name || 'a client'}`,
      heading: 'A deposit refund did not go through',
      text: `${ctx.client_name || 'Your client'} cancelled ${apptLabel(ctx)} before your cancellation window, so their ${fmtMoney(amount, currency)} deposit should go back to them. The refund did not go through (${msg}). Please refund it from the booking or from your payment account.`,
    });
    return { refunded: 0, error: msg };
  }
}

// ── Entry points ───────────────────────────────────────────────────────

// The client cancelled (portal). Call AFTER the cancel UPDATE won, so only
// one request ever runs this for a booking.
export async function settleClientCancellation({ workspaceId, bookingId, nowMs = Date.now() }) {
  const ctx = await loadFeeContext({ workspaceId, bookingId });
  if (!ctx) return null;
  const [accepted, settings] = await Promise.all([
    acceptedTermsForBooking({ workspaceId, bookingId }), getPolicySettings(workspaceId),
  ]);
  const terms = effectiveTerms(ctx, accepted, settings);
  const late = isInsideWindow(ctx, terms.windowHours, nowMs);
  const held = depositHeldCents(ctx);
  const out = {
    late, windowHours: terms.windowHours, currency: ctx.currency,
    feeChargedCents: 0, feeFromDepositCents: 0, feeError: null, invoice: null,
    depositRefundedCents: 0, depositKeptCents: 0, depositRefundError: null,
    packageSessionKept: false, depositRefundRequestedCents: 0, businessName: ctx.biz_name || null,
  };
  if (!late) {
    if (held > 0 && terms.refundDepositOutsideWindow) {
      const r = await requestDepositRefund({ ctx, by: 'client', nowMs });
      out.depositRefundRequestedCents = r.requestedCents || 0;
    } else {
      out.depositKeptCents = held;
    }
    return out;
  }
  out.depositKeptCents = held;
  const feeCents = toCents(terms.lateFee);
  // Package session under "used when booked": the late cancel keeps the
  // session used INSTEAD of a fee (the session is the penalty, never
  // both). Under "used when completed" the session was only held, so the
  // caller releases it and the normal late fee below applies once.
  if (feeCents > 0 && isPackageUsedWhenBooked(ctx)) {
    out.packageSessionKept = true;
    return out;
  }
  if (feeCents > 0) {
    const fromDep = Math.min(held, feeCents);
    const r = await chargeFee({ ctx, kind: 'late_cancel', dueCents: feeCents - fromDep, fromDepositCents: fromDep });
    out.feeChargedCents = r.charged || 0;
    out.feeFromDepositCents = r.fromDeposit || 0;
    out.feeError = r.error || null;
    out.invoice = r.invoice || null;
  }
  return out;
}

// The business cancelled. Never a fee. refund: true = the owner ticked
// "Refund the deposit" while cancelling (that tap is the approval, refund
// now); false = keep it; undefined (older apps, Ivy) = open a refund
// request for one-tap approval.
export async function settleOwnerCancellation({ workspaceId, bookingId, refund, userId = null }) {
  const ctx = await loadFeeContext({ workspaceId, bookingId });
  if (!ctx) return null;
  const held = depositHeldCents(ctx);
  if (held <= 0) return { depositRefundedCents: 0, depositKeptCents: 0 };
  if (refund === false) return { depositRefundedCents: 0, depositKeptCents: held };
  if (refund === true) {
    const r = await refundDeposit({ ctx, reason: 'requested_by_customer', who: 'owner' });
    if (r.refunded && userId) {
      await sql`UPDATE bookings SET deposit_refund_decided_by = ${userId} WHERE id = ${ctx.id} AND workspace_id = ${workspaceId}`;
    }
    return { depositRefundedCents: r.refunded || 0, depositKeptCents: r.refunded ? 0 : held, depositRefundError: r.error || null };
  }
  const q = await requestDepositRefund({ ctx, by: 'owner' });
  return { depositRefundedCents: 0, depositKeptCents: 0, depositRefundRequestedCents: q.requestedCents || 0 };
}

function aheadLabel(ms) {
  const h = Math.floor(ms / 3_600_000);
  if (h >= 48) return `${Math.floor(h / 24)} days ahead`;
  if (h >= 24) return '1 day ahead';
  if (h >= 1) return `${h} hour${h === 1 ? '' : 's'} ahead`;
  return 'shortly before';
}

// Open a pending deposit refund request (never refunds by itself) and ask
// the owner: push + email + the "Deposits to review" list. At most one
// pending request per booking.
export async function requestDepositRefund({ ctx, by = 'client', nowMs = Date.now() }) {
  const held = depositHeldCents(ctx);
  if (held <= 0 || !ctx.deposit_payment_intent || !ctx.deposit_paid_at) return { requestedCents: 0 };
  const startMs = slotEpochMs(isoDate(ctx.date), Number(ctx.start_min), ctx.timezone || null);
  const reason = by === 'owner'
    ? 'you cancelled the booking'
    : `cancelled ${Number.isFinite(startMs) ? aheadLabel(startMs - nowMs) : 'in time'}, your policy refunds it`;
  const upd = await sql`
    UPDATE bookings SET
      deposit_refund_request_status = 'pending',
      deposit_refund_request_amount = ${held / 100},
      deposit_refund_request_reason = ${reason},
      deposit_refund_requested_at = NOW(),
      deposit_refund_decided_at = NULL, deposit_refund_decided_by = NULL,
      updated_at = NOW()
    WHERE id = ${ctx.id} AND workspace_id = ${ctx.workspace_id}
      AND deposit_refund_request_status IS DISTINCT FROM 'pending'
    RETURNING id
  `;
  if (upd.rows.length === 0) return { requestedCents: 0, deduped: true };
  const currency = String(ctx.currency || 'USD').toUpperCase();
  const first = String(ctx.c_name || ctx.client_name || 'Your client').trim().split(/\s+/)[0];
  const question = `Refund ${first}'s ${fmtMoney(held, currency)} deposit? (${reason})`;
  notifyOwnerSafe({
    workspaceId: ctx.workspace_id, type: 'payments',
    payload: { title: 'Deposit refund to review', body: question, url: `/calendar?depositReview=${ctx.id}`, tag: `depreview-${ctx.id}` },
  });
  await emailOwner(ctx, {
    subject: question,
    heading: 'A deposit refund is waiting for you',
    text: `${question} ${apptLabel(ctx)}. Nothing has been refunded yet. Open your calendar to tap Refund or Keep deposit.`,
    ctaUrl: `${appUrl()}/calendar?depositReview=${ctx.id}`,
  });
  return { requestedCents: held };
}

// The owner's one tap. decision 'refund' runs the refund exactly once
// (the status flip is the claim; a double tap finds it already decided);
// 'keep' records that the deposit stays, with who and when.
export async function decideDepositRefund({ workspaceId, bookingId, decision, userId = null }) {
  if (decision !== 'refund' && decision !== 'keep') return { invalid: true };
  const next = decision === 'refund' ? 'approved' : 'kept';
  const flip = await sql`
    UPDATE bookings SET deposit_refund_request_status = ${next},
      deposit_refund_decided_at = NOW(), deposit_refund_decided_by = ${userId}, updated_at = NOW()
    WHERE id = ${bookingId} AND workspace_id = ${workspaceId}
      AND deposit_refund_request_status = 'pending'
    RETURNING deposit_refund_request_amount
  `;
  if (flip.rows.length === 0) {
    const cur = await sql`SELECT deposit_refund_request_status FROM bookings WHERE id = ${bookingId} AND workspace_id = ${workspaceId}`;
    if (!cur.rows[0]) return { notFound: true };
    return { alreadyDecided: true, status: cur.rows[0].deposit_refund_request_status || null };
  }
  if (decision === 'keep') return { kept: true };
  const ctx = await loadFeeContext({ workspaceId, bookingId });
  const r = await refundDeposit({
    ctx, amountCents: toCents(flip.rows[0].deposit_refund_request_amount),
    who: ctx.cancelled_by === 'owner' ? 'owner' : 'policy',
  });
  if (!r.refunded) {
    // Refund did not go through: back to pending so the owner can retry.
    await sql`
      UPDATE bookings SET deposit_refund_request_status = 'pending', deposit_refund_decided_at = NULL, deposit_refund_decided_by = NULL
      WHERE id = ${bookingId} AND workspace_id = ${workspaceId} AND deposit_refund_request_status = 'approved'
        AND ROUND(COALESCE(deposit_refunded_amount, 0) * 100) = ${toCents(ctx.deposit_refunded_amount)}
    `;
    return { refunded: 0, error: r.error || 'The refund did not go through.' };
  }
  return { refunded: r.refunded };
}

// Pending requests for the "Deposits to review" list.
export async function listDepositReviews(workspaceId) {
  const { rows } = await sql`
    SELECT b.id, b.client_id, b.client_name, b.date, b.start_min, b.cancelled_at, b.cancelled_by,
           b.deposit_refund_request_amount, b.deposit_refund_request_reason, b.deposit_refund_requested_at,
           s.name AS service_name, COALESCE(fs.currency, 'USD') AS currency
      FROM bookings b
      LEFT JOIN services s ON s.id = b.service_id AND s.workspace_id = b.workspace_id
      LEFT JOIN finance_settings fs ON fs.workspace_id = b.workspace_id
     WHERE b.workspace_id = ${workspaceId} AND b.deposit_refund_request_status = 'pending'
     ORDER BY b.deposit_refund_requested_at ASC
     LIMIT 100
  `;
  return rows.map((r) => ({
    bookingId: r.id, clientId: r.client_id, clientName: r.client_name, serviceName: r.service_name || null,
    date: isoDate(r.date), startMin: r.start_min, cancelledBy: r.cancelled_by || null,
    amount: Number(r.deposit_refund_request_amount || 0), currency: String(r.currency).toUpperCase(),
    reason: r.deposit_refund_request_reason || '', requestedAt: r.deposit_refund_requested_at,
  }));
}

// No-show fee (owner marked the booking). The kept deposit counts first.
export async function chargeNoShowFee({ workspaceId, bookingId }) {
  const ctx = await loadFeeContext({ workspaceId, bookingId });
  if (!ctx) return null;
  const [accepted, settings] = await Promise.all([
    acceptedTermsForBooking({ workspaceId, bookingId }), getPolicySettings(workspaceId),
  ]);
  // Package session under "used when booked": the used session is the
  // penalty, no no-show fee. Under "used when completed" the no-show uses
  // the held session AND the no-show fee applies once.
  if (isPackageUsedWhenBooked(ctx)) return { charged: 0, fromDeposit: 0, noFee: true, packageSession: true };
  const terms = effectiveTerms(ctx, accepted, settings);
  const feeCents = toCents(terms.noShowFee);
  if (feeCents <= 0) return { charged: 0, fromDeposit: 0, noFee: true };
  const held = depositHeldCents(ctx);
  const fromDep = Math.min(held, feeCents);
  return chargeFee({ ctx, kind: 'no_show', dueCents: feeCents - fromDep, fromDepositCents: fromDep });
}

// Owner's manual "Charge fee". amount (dollars) overrides the policy amount
// and goes on the card as typed; without it, the policy fee less the kept
// deposit.
export async function chargeFeeManually({ workspaceId, bookingId, kind, amount = null }) {
  const ctx = await loadFeeContext({ workspaceId, bookingId });
  if (!ctx) return { notFound: true };
  if (ctx.fee_charged_kind || Number(ctx.fee_charged_amount) > 0) return { alreadyCharged: true };
  if (ctx.fee_invoice_id) {
    const inv = await sql`SELECT status, number FROM invoices WHERE id = ${ctx.fee_invoice_id} AND workspace_id = ${workspaceId}`;
    const st = inv.rows[0]?.status;
    if (st && st !== 'draft' && st !== 'voided') {
      return { openInvoice: inv.rows[0].number, invoiceStatus: st };
    }
  }
  if (amount != null) {
    return chargeFee({ ctx, kind, dueCents: toCents(amount), fromDepositCents: 0 });
  }
  const [accepted, settings] = await Promise.all([
    acceptedTermsForBooking({ workspaceId, bookingId }), getPolicySettings(workspaceId),
  ]);
  const terms = effectiveTerms(ctx, accepted, settings);
  const feeCents = toCents(kind === 'late_cancel' ? terms.lateFee : terms.noShowFee);
  if (feeCents <= 0) return { noFee: true };
  const fromDep = Math.min(depositHeldCents(ctx), feeCents);
  return chargeFee({ ctx, kind, dueCents: feeCents - fromDep, fromDepositCents: fromDep });
}

// Owner's "Refund deposit" button (cancelled booking whose deposit was
// kept, or a refund that failed earlier).
export async function refundDepositManually({ workspaceId, bookingId, amount = null }) {
  const ctx = await loadFeeContext({ workspaceId, bookingId });
  if (!ctx) return { notFound: true };
  if (depositHeldCents(ctx) <= 0) return { nothingHeld: true };
  // Never refund the part of the deposit that already paid a fee.
  const usable = Math.max(0, depositHeldCents(ctx) - toCents(ctx.fee_from_deposit_amount));
  if (usable <= 0) return { coversFee: true };
  const amt = amount == null ? usable : Math.min(usable, toCents(amount));
  if (amt <= 0) return { nothingHeld: true };
  return refundDeposit({ ctx, amountCents: amt, who: 'owner' });
}

// Text the client sees in their portal response after cancelling.
export function describeClientCancellation(o) {
  if (!o) return null;
  const c = String(o.currency || 'USD').toUpperCase();
  const parts = [];
  if (o.packageSessionKept) parts.push(`You cancelled inside the ${o.windowHours}-hour window, so this session stays used from your package. No fee is charged.`);
  if (o.depositRefundedCents > 0) parts.push(`Your ${fmtMoney(o.depositRefundedCents, c)} deposit is being refunded.`);
  if (o.depositRefundRequestedCents > 0) parts.push(`Your ${fmtMoney(o.depositRefundRequestedCents, c)} deposit refund is being reviewed by ${o.businessName || 'the business'}. You will get a receipt once it is approved.`);
  if (o.late && o.depositKeptCents > 0) parts.push(`You cancelled inside the ${o.windowHours}-hour window, so the ${fmtMoney(o.depositKeptCents, c)} deposit is kept.`);
  if (o.feeChargedCents > 0) parts.push(`A ${fmtMoney(o.feeChargedCents, c)} late-cancellation fee was charged to your card.`);
  if (o.feeError) parts.push('The late-cancellation fee could not be charged to your card. The business may send you an invoice.');
  return parts.join(' ') || null;
}

export function serviceHasFees(svc) {
  if (!svc) return false;
  return Number(svc.cancellation_fee_amount ?? svc.cancellationFeeAmount ?? 0) > 0
    || Number(svc.no_show_fee_amount ?? svc.noShowFeeAmount ?? 0) > 0;
}

// Card on file at booking time, for services with a late-cancel or
// no-show fee, when the business takes cards through Stripe.
//   mode 'customer' → { customerId } so the deposit checkout keeps the card
//   mode 'setup'    → { url } of a Stripe page that saves a card, no charge
// Only offered while the client has NO card on file: an anonymous booking
// form must never be able to replace a card the client already saved.
export async function cardOnFileCheckout({ workspaceId, clientId, service, mode = 'setup', successUrl, cancelUrl }) {
  if (!clientId || !serviceHasFees(service)) return null;
  const fs = await fetchFinanceSettings(workspaceId);
  if (!fs || (fs.paymentProvider || 'stripe') !== 'stripe') return null;
  if (!(fs.stripeConnectUserId || fs.stripeSecretEncrypted)) return null;
  const { rows } = await sql`
    SELECT id, workspace_id, email, name, stripe_customer_id, payment_method_id
      FROM clients WHERE id = ${clientId} AND workspace_id = ${workspaceId} LIMIT 1
  `;
  const client = rows[0];
  if (!client?.email || client.payment_method_id) return null;
  const creds = await loadStripeCreds(workspaceId);
  const customerId = await ensureStripeCustomer({ creds, client });
  if (!customerId) return null;
  if (mode === 'customer') return { customerId };
  const s = await createSetupCheckoutSession({
    secretKey: creds.secretKey, stripeAccount: creds.stripeAccount,
    customerId, workspaceId, clientId, successUrl, cancelUrl,
  });
  return s?.url ? { url: s.url } : null;
}
