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
import { appUrl } from './tokens.js';
import { reportError } from './monitoring.js';

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
        <strong>${escapeHtml(inv.number)}</strong>${method && method !== 'other' ? ` (paid by ${escapeHtml(method)})` : ''}.</p>
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
