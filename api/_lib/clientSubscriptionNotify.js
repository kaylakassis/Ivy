// A client's recurring payment to a business failed (membership or program
// subscription went past_due on Stripe). Tell both sides once per
// transition: the owner gets a push, the client an email that says what to
// do. Best-effort: never throws, never blocks the webhook ack.
import { sql } from './db.js';
import { notifyOwnerSafe } from './push.js';
import { sendEmailToClient, emailShell } from './email.js';
import { fetchBranding } from './branding.js';
import { appUrl } from './tokens.js';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function renderClientPaymentFailed({ business, firstName, label, branding }) {
  const biz = escapeHtml(business || 'the business');
  const what = escapeHtml(label || 'your subscription');
  const html = emailShell({
    heading: 'Payment did not go through',
    branding,
    body: `<p>Hi ${escapeHtml(firstName || 'there')},</p>
      <p>The latest payment for <strong>${what}</strong> with ${biz} did not go through.</p>
      <p>Your access continues for now while the payment is retried. To avoid losing it, update your card on your Billing page or reply to this email to sort it out with ${biz}.</p>`,
    ctaText: 'Open Billing',
    ctaUrl: `${appUrl()}/me/billing`,
    footer: `Questions? Reply to this email to reach ${biz}.`,
  });
  return { subject: `Payment failed: ${label || 'your subscription'} with ${business || 'your business'}`, html };
}

// kind: 'membership' | 'program'. label: tier or program title.
export async function notifyClientSubscriptionPastDue({ workspaceId, clientId, kind, label }) {
  try {
    const client = (await sql`
      SELECT id, name, email FROM clients WHERE id = ${clientId} AND workspace_id = ${workspaceId}
    `).rows[0];
    if (!client) return { sent: false };
    const noun = kind === 'program' ? 'program' : 'membership';
    notifyOwnerSafe({
      workspaceId, type: 'payments',
      payload: {
        title: 'Payment failed',
        body: `${client.name || client.email || 'A client'} · ${label || noun} payment did not go through. Stripe will retry.`,
        url: kind === 'program' ? '/programs' : '/finance',
        tag: `${noun}-past-due-${clientId}`,
      },
    });
    if (!client.email) return { sent: false };
    const branding = await fetchBranding(workspaceId);
    const rendered = renderClientPaymentFailed({
      business: branding.businessName,
      firstName: (client.name || '').split(/\s+/)[0],
      label,
      branding,
    });
    const r = await sendEmailToClient({
      clientId: client.id, type: 'invoices', to: client.email,
      subject: rendered.subject, html: rendered.html, replyTo: branding.replyTo,
    });
    return { sent: !!r?.sent };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[clientSubscriptionNotify] failed:', err.message);
    return { sent: false };
  }
}
