// "Refund issued" email for purchases that have no invoice row: a one-time
// program, a gift card, a package. Modelled on renderInvoiceRefunded in
// invoiceNotify.js (amount, what it was for, 5 to 10 business days) and
// shared by BOTH refund paths - the owner's Refund button in Ivy
// (purchaseRefunds.js) and a refund made in the payment dashboard
// (charge.refunded, via syncRefundToPurchases / revokeProgramPurchaseForRefund)
// - so the client hears about a refund exactly once, from whichever write
// actually changed the purchase.
import { sql } from './db.js';
import { sendEmailToClient, sendEmailToClientByAddress, emailShell } from './email.js';
import { fetchBranding } from './branding.js';
import { reportError } from './monitoring.js';

function fmtMoney(cents) {
  return '$' + (Number(cents || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export const PURCHASE_KIND_LABELS = { program: 'program', gift_card: 'gift card', package: 'package' };

// kind: 'program' | 'gift_card' | 'package'. `label` names the thing
// (program title, "gift card ending 1234", package name).
export function renderPurchaseRefunded({ business, firstName, kind, label, amountCents, remainingCents, fully, branding }) {
  const fn = escapeHtml(firstName || 'there');
  const biz = escapeHtml(business || 'the business');
  const amt = fmtMoney(amountCents);
  const what = kind === 'gift_card' ? `the ${escapeHtml(label)}` : `<strong>${escapeHtml(label)}</strong>`;
  const consequence = kind === 'program'
    ? (fully ? 'Your access to the program has ended.' : 'Your access to the program continues.')
    : kind === 'gift_card'
      ? (fully ? 'The gift card can no longer be used.' : 'The balance on the gift card has been lowered to match.')
      : (fully ? 'The remaining sessions on this package have been cancelled.' : 'Your remaining sessions are unchanged unless the business tells you otherwise.');
  const scope = fully
    ? `<p>This purchase is now fully refunded. ${consequence}</p>`
    : `<p>This is a partial refund. ${fmtMoney(remainingCents)} of your payment stays applied. ${consequence}</p>`;
  const html = emailShell({
    heading: 'Refund issued',
    branding,
    body: `<p>Hi ${fn},</p>
      <p>${biz} has refunded <strong>${amt}</strong> for ${what}.</p>
      <p>The money is on its way back to your original payment method. Most banks and card issuers show it within <strong>5 to 10 business days</strong>.</p>
      ${scope}
      <p>Keep this email as your refund receipt.</p>`,
    footer: `Questions about this refund? Reply to this email to reach ${biz}.`,
  });
  return { subject: `Refund issued: ${label} · ${amt}`, html };
}

// Send the email. `to` / `name` identify the buyer; `clientId` (when the
// buyer is a client row) routes through the client's email preferences,
// otherwise the (workspace, email) pair does. Never throws.
export async function notifyPurchaseRefunded({ workspaceId, kind, label, amountCents, remainingCents, fully, clientId = null, to = null, name = null }) {
  try {
    if (!to || !(Number(amountCents) > 0)) return { sent: false };
    const branding = await fetchBranding(workspaceId);
    const rendered = renderPurchaseRefunded({
      business: branding.businessName, firstName: (name || '').split(/\s+/)[0],
      kind, label, amountCents: Number(amountCents), remainingCents: Math.max(0, Number(remainingCents || 0)), fully: !!fully, branding,
    });
    const common = { type: 'invoices', subject: rendered.subject, html: rendered.html, replyTo: branding.replyTo };
    const r = clientId
      ? await sendEmailToClient({ clientId, to, ...common })
      : await sendEmailToClientByAddress({ workspaceId, email: to, ...common });
    return { sent: !!r?.sent };
  } catch (err) {
    console.error('[notifyPurchaseRefunded] failed:', err.message);
    reportError(err, { extra: { workspaceId, kind } });
    return { sent: false };
  }
}

// Buyer lookup for a client-row purchase (program enrollment, package).
export async function clientContact({ workspaceId, clientId }) {
  if (!clientId) return null;
  const r = await sql`SELECT id, name, email FROM clients WHERE id = ${clientId} AND workspace_id = ${workspaceId} LIMIT 1`;
  return r.rows[0] || null;
}
