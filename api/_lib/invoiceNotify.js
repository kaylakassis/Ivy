// Invoice lifecycle emails (paid, overdue). The "sent" email is wired
// from /api/invoices/send.js (manual) and /api/cron/recurring-invoices.js
// (auto). This file adds:
//   • notifyInvoicePaid    - fires from both the Stripe webhook and the
//                            owner's manual "Mark paid" endpoint.
//   • notifyInvoiceOverdue - fires from a daily cron that catches sent
//                            invoices past due_date.
import { sql } from './db.js';
import { sendEmailToClient, emailShell } from './email.js';
import { fetchBranding } from './branding.js';
import { celebrateFirstPayment, celebrateRevenueMonthMilestone } from './milestones.js';
import { recordFirstRealPayment } from './firstWin.js';
import { appUrl } from './tokens.js';
import { reportError } from './monitoring.js';
import { paidMethodLabel } from './finance.js';

function fmtMoney(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDate(d) {
  if (!d) return '';
  const date = d instanceof Date ? d : new Date(typeof d === 'string' ? (d.length === 10 ? d + 'T00:00:00' : d) : d);
  return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export async function notifyInvoicePaid({ workspaceId, invoiceId, totalAmount, method = 'card' }) {
  // Payment milestones - owner-facing, independent of whether the invoice has a
  // client email (so they fire even for a walk-in receipt-less sale). First
  // payment, then each time a calendar month's revenue crosses a tier.
  // The first REAL payment (not sample data) is the first-win moment: it
  // flags the dashboard celebration and sends its own notification, so the
  // generic first-payment milestone only runs when that did not fire.
  const firstWin = await recordFirstRealPayment({ workspaceId, invoiceId });
  if (!firstWin) await celebrateFirstPayment(workspaceId);
  await celebrateRevenueMonthMilestone(workspaceId);
  try {
    const { rows } = await sql`
      SELECT i.id, i.number, i.client_id, i.client_name, i.client_email,
             i.paid_amount, i.paid_at, i.workspace_id
      FROM invoices i
      WHERE i.id = ${invoiceId} AND i.workspace_id = ${workspaceId}
    `;
    const inv = rows[0];
    if (!inv?.client_email) return;
    const branding = await fetchBranding(workspaceId);
    const business = branding.businessName || 'your business';
    const amount = totalAmount != null ? Number(totalAmount) : Number(inv.paid_amount || 0);
    const html = emailShell({
      heading: 'Payment received',
      branding,
      body: `<p>Hi ${escapeHtml((inv.client_name || '').split(/\s+/)[0] || 'there')},</p>
        <p>Thanks - we received your payment of <strong>${fmtMoney(amount)}</strong> for invoice
        <strong>${escapeHtml(inv.number)}</strong>${method && method !== 'other' ? ` (paid by ${escapeHtml(paidMethodLabel(method))})` : ''}.</p>
        <p>This email is your receipt.</p>`,
      footer: `Need anything? Reply to this email to reach ${escapeHtml(business)}.`,
    });
    await sendEmailToClient({
      clientId: inv.client_id, type: 'invoices',
      to: inv.client_email,
      subject: `Receipt: invoice ${inv.number} · ${fmtMoney(amount)}`,
      html,
      replyTo: branding.replyTo,
    });
  } catch (err) {
    console.error('[notifyInvoicePaid] failed:', err.message);
    reportError(err, { extra: { invoiceId, workspaceId } });
  }
}

// Refund confirmation to the client. Fires once per refund that actually
// changed the invoice: from the shared refund core (owner's Refund button
// and Ivy's refund_invoice tool) and from the Stripe webhook when the owner
// refunds straight from the Stripe Dashboard. The echo of an Ivy refund is
// ignored upstream, so the client never gets two.
//
// Copy is honest about who moves the money: online payments go back to
// the original method automatically; manual ones (cash, check, Zelle,
// Venmo, Cash App) are sent back by the business, so we say that.
const ONLINE_REFUND_METHODS = new Set(['card', 'ach', 'paypal', 'square', 'stripe']);

export function renderInvoiceRefunded({ business, firstName, number, amount, remaining, fullyRefunded, method, online, branding }) {
  const fn = escapeHtml(firstName || 'there');
  const biz = escapeHtml(business || 'the business');
  const amt = fmtMoney(amount);
  const how = online
    ? (method === 'ach'
      ? `<p>The money is on its way back to the bank account you paid from. Most banks show it within <strong>5 to 10 business days</strong>.</p>`
      : `<p>The money is on its way back to your original payment method. Most banks and card issuers show it within <strong>5 to 10 business days</strong>.</p>`)
    : `<p>You paid this invoice by ${escapeHtml(paidMethodLabel(method))}, so ${biz} will send the money back to you directly. If you have not received it in a few days, just reply to this email.</p>`;
  const scope = fullyRefunded
    ? `<p>Invoice <strong>${escapeHtml(number)}</strong> is now fully refunded.</p>`
    : `<p>This is a partial refund. ${fmtMoney(remaining)} of your payment stays applied to invoice <strong>${escapeHtml(number)}</strong>.</p>`;
  const html = emailShell({
    heading: 'Refund issued',
    branding,
    body: `<p>Hi ${fn},</p>
      <p>${biz} has refunded <strong>${amt}</strong> for invoice <strong>${escapeHtml(number)}</strong>.</p>
      ${how}
      ${scope}
      <p>Keep this email as your refund receipt.</p>`,
    footer: `Questions about this refund? Reply to this email to reach ${biz}.`,
  });
  return { subject: `Refund issued: invoice ${number} · ${amt}`, html };
}

export async function notifyInvoiceRefunded({ workspaceId, invoiceId, amount, method = null }) {
  try {
    const { rows } = await sql`
      SELECT i.id, i.number, i.client_id, i.client_name, i.client_email,
             i.paid_amount, i.refunded_amount, i.status, i.paid_method, i.stripe_payment_intent
      FROM invoices i
      WHERE i.id = ${invoiceId} AND i.workspace_id = ${workspaceId}
    `;
    const inv = rows[0];
    if (!inv?.client_email || !(Number(amount) > 0)) return { sent: false };
    const branding = await fetchBranding(workspaceId);
    const m = method || inv.paid_method || (inv.stripe_payment_intent ? 'card' : 'other');
    const online = !!inv.stripe_payment_intent || ONLINE_REFUND_METHODS.has(m);
    const paid = Number(inv.paid_amount || 0);
    const refunded = Number(inv.refunded_amount || 0);
    const rendered = renderInvoiceRefunded({
      business: branding.businessName,
      firstName: (inv.client_name || '').split(/\s+/)[0],
      number: inv.number,
      amount: Number(amount),
      remaining: Math.max(0, paid - refunded),
      fullyRefunded: inv.status === 'refunded' || (paid > 0 && refunded >= paid - 0.001),
      method: m,
      online,
      branding,
    });
    const r = await sendEmailToClient({
      clientId: inv.client_id, type: 'invoices',
      to: inv.client_email,
      subject: rendered.subject,
      html: rendered.html,
      replyTo: branding.replyTo,
    });
    return { sent: !!r?.sent };
  } catch (err) {
    console.error('[notifyInvoiceRefunded] failed:', err.message);
    reportError(err, { extra: { invoiceId, workspaceId } });
    return { sent: false };
  }
}

// Friendly "payment due soon" nudge - fires a few days BEFORE due_date,
// once per invoice. The proactive counterpart to notifyInvoiceOverdue.
export async function notifyInvoiceDueSoon({ workspaceId, invoiceId, daysUntilDue, viewUrl }) {
  try {
    const { rows } = await sql`
      SELECT i.id, i.number, i.client_id, i.client_name, i.client_email,
             i.due_date, i.items, i.tax_rate, i.discount
      FROM invoices i
      WHERE i.id = ${invoiceId} AND i.workspace_id = ${workspaceId}
    `;
    const inv = rows[0];
    if (!inv?.client_email) return;
    const { computeTotals } = await import('./finance.js');
    const totals = computeTotals(inv.items, inv.tax_rate, inv.discount);
    const branding = await fetchBranding(workspaceId);
    const business = branding.businessName || 'your business';
    const whenLabel = daysUntilDue <= 0 ? 'today'
      : daysUntilDue === 1 ? 'tomorrow'
      : `in ${daysUntilDue} days`;
    const html = emailShell({
      heading: `A quick heads-up on invoice ${escapeHtml(inv.number)}`,
      branding,
      body: `<p>Hi ${escapeHtml((inv.client_name || '').split(/\s+/)[0] || 'there')},</p>
        <p>Just a friendly reminder that invoice <strong>${escapeHtml(inv.number)}</strong>
        for <strong>${fmtMoney(totals.total)}</strong> is due <strong>${whenLabel}</strong>${inv.due_date ? ` (${escapeHtml(fmtDate(inv.due_date))})` : ''}.</p>
        <p>You can pay it in a couple of taps using the button below. If you've already taken care of it, thank you - no need to do anything.</p>`,
      ctaText: 'View & pay invoice',
      ctaUrl: viewUrl || `${appUrl()}`,
      footer: `Questions? Just reply to this email to reach ${escapeHtml(business)}.`,
    });
    await sendEmailToClient({
      clientId: inv.client_id, type: 'invoices',
      to: inv.client_email,
      subject: `Reminder: invoice ${inv.number} is due ${whenLabel}`,
      html,
      replyTo: branding.replyTo,
    });
  } catch (err) {
    console.error('[notifyInvoiceDueSoon] failed:', err.message);
    reportError(err, { extra: { invoiceId, workspaceId } });
  }
}

// Single-invoice overdue reminder. Cron picks the row + calls this.
export async function notifyInvoiceOverdue({ workspaceId, invoiceId, daysOverdue, viewUrl }) {
  try {
    const { rows } = await sql`
      SELECT i.id, i.number, i.client_id, i.client_name, i.client_email,
             i.due_date, i.items, i.tax_rate, i.discount
      FROM invoices i
      WHERE i.id = ${invoiceId} AND i.workspace_id = ${workspaceId}
    `;
    const inv = rows[0];
    if (!inv?.client_email) return;
    const { computeTotals } = await import('./finance.js');
    const totals = computeTotals(inv.items, inv.tax_rate, inv.discount);
    const branding = await fetchBranding(workspaceId);
    const business = branding.businessName || 'your business';
    const html = emailShell({
      heading: `Invoice ${escapeHtml(inv.number)} is overdue`,
      branding,
      body: `<p>Hi ${escapeHtml((inv.client_name || '').split(/\s+/)[0] || 'there')},</p>
        <p>This is a friendly reminder that invoice <strong>${escapeHtml(inv.number)}</strong>
        for <strong>${fmtMoney(totals.total)}</strong> is${inv.due_date ? ` past due (was due ${escapeHtml(fmtDate(inv.due_date))}, ${daysOverdue} day${daysOverdue === 1 ? '' : 's'} overdue)` : ' overdue'}.</p>
        <p>If you've already paid, please ignore - it can take a day or two to clear.</p>`,
      ctaText: 'Open invoice',
      ctaUrl: viewUrl || `${appUrl()}`,
      footer: `Reply to this email if there's anything to flag.`,
    });
    await sendEmailToClient({
      clientId: inv.client_id, type: 'invoices',
      to: inv.client_email,
      subject: `Reminder: invoice ${inv.number} is overdue`,
      html,
      replyTo: branding.replyTo,
    });
  } catch (err) {
    console.error('[notifyInvoiceOverdue] failed:', err.message);
    reportError(err, { extra: { invoiceId, workspaceId } });
  }
}
