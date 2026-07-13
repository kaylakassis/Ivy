// Preview-only renderers for every transactional template not already
// exposed as a pure render* in subscriptionNotify / securityNotify /
// welcome-content. Each function takes sample merge data and returns
// { subject, html } via emailShell — the same shell production uses.
//
// Why a parallel renderer (vs. extracting render* from every notify in
// the codebase): the high-iteration platform funnel templates (trial,
// billing, security) ARE extracted as pure renderers and shared with
// production. The templates here (booking, invoice, account, admin
// invites, etc.) are stable enough that a small amount of duplication
// is cheap insurance — and lets the admin preview every email without
// touching 12 production files at once. If you later edit the copy in
// the production notify function, update the matching renderer here so
// the preview keeps matching. The preview's purpose is to LOOK at the
// real copy, not to author it.
import { emailShell } from './email.js';
import { appUrl } from './tokens.js';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function firstName(name) { return (name || '').split(/\s+/)[0] || 'there'; }
function fmtMoney(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDate(d) {
  if (!d) return '';
  const date = d instanceof Date ? d : new Date(d);
  return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}
function fmtDateShort(d) {
  if (!d) return '';
  const date = d instanceof Date ? d : new Date(d);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// Sample branding used for every white-labeled end-customer renderer.
// Mirrors what fetchBranding(workspaceId) returns at send time.
export const SAMPLE_BRANDING = {
  businessName: 'Market Theory Studio',
  accentColor:  '#CFFF50',
  logoUrl:      null,
  emailSignature: '— The Market Theory Team',
  replyTo:      'hello@example.com',
};

// ─────────────────────────────────────────────────────────────────────
// Auth / account
// ─────────────────────────────────────────────────────────────────────

export function renderVerifyEmail({ firstName: fnRaw, link }) {
  const fn = escapeHtml(firstName(fnRaw));
  const url = link || `${appUrl()}/verify-email?token=PREVIEW_TOKEN_xxxxxxxx`;
  return {
    subject: 'Confirm your email for Ivy',
    html: emailShell({
      heading: 'Confirm your email',
      preheader: 'Tap the button to verify your account.',
      body: `<p>Hi ${fn},</p>
        <p>Welcome to Ivy! Tap the button below to verify your email and finish setting up your account.</p>
        <p style="color:#8A8D85;font-size:12.5px;">This link expires in 24 hours. If you didn't sign up for Ivy, you can ignore this email.</p>`,
      ctaText: 'Verify my email',
      ctaUrl: url,
      footer: `Trouble with the button? Paste this link into your browser. — The Ivy Team`,
    }),
  };
}

export function renderPasswordReset({ firstName: fnRaw, link }) {
  const fn = escapeHtml(firstName(fnRaw));
  const url = link || `${appUrl()}/reset-password?token=PREVIEW_TOKEN_xxxxxxxx`;
  return {
    subject: 'Reset your Ivy password',
    html: emailShell({
      heading: 'Reset your password',
      preheader: 'Tap the button to choose a new password.',
      body: `<p>Hi ${fn},</p>
        <p>Someone (hopefully you) requested a password reset on your Ivy account. Tap the button to choose a new password.</p>
        <p style="color:#8A8D85;font-size:12.5px;">This link expires in 1 hour. If you didn't request a reset, you can safely ignore this email — your password stays the same.</p>`,
      ctaText: 'Reset my password',
      ctaUrl: url,
      footer: `For your security, links can only be used once. — The Ivy Team`,
    }),
  };
}

export function renderAccountDeletionRequest({ firstName: fnRaw, finalDeleteDate, recoverUrl }) {
  const fn = escapeHtml(firstName(fnRaw));
  const supportEmail = process.env.EMAIL_REPLY_TO || 'hello@getivyos.com';
  const url = recoverUrl || `${appUrl()}/account-recover?token=PREVIEW_TOKEN_xxxxxxxx`;
  const date = fmtDate(finalDeleteDate || new Date(Date.now() + 30 * 86400000));
  return {
    subject: 'Your Ivy account deletion request',
    html: emailShell({
      heading: 'Your account deletion request',
      preheader: `Here's what happens — and how to cancel.`,
      body: `<p>Hi ${fn},</p>
        <p>We've received your request to delete your Ivy account. Here's what happens next:</p>
        <ul style="padding-left:20px;margin:14px 0;">
          <li>Your account is scheduled for permanent deletion on <strong>${escapeHtml(date)}</strong></li>
          <li>Until then, it's deactivated but <strong>recoverable</strong></li>
          <li>After that date, your data is permanently erased and can't be restored</li>
        </ul>
        <p><strong>Changed your mind?</strong> One-click restore using the button below — works any time before ${escapeHtml(date)}.</p>
        <p>(Businesses you were a client of keep their own records of your transactions with them, as they're required to.)</p>`,
      ctaText: 'Keep my account →',
      ctaUrl: url,
      footer: `Thanks for trying Ivy. Questions? <a href="mailto:${escapeHtml(supportEmail)}" style="color:#CFFF50;text-decoration:underline;">${escapeHtml(supportEmail)}</a>. — The Ivy Team`,
    }),
  };
}

export function renderAccountRestored({ firstName: fnRaw }) {
  const fn = escapeHtml(firstName(fnRaw));
  return {
    subject: 'Your Ivy account is restored',
    html: emailShell({
      heading: 'Welcome back',
      preheader: `Your account and data are right where you left them.`,
      body: `<p>Hi ${fn},</p>
        <p>Your Ivy account is restored. Your clients, bookings, invoices, documents, and history are exactly where you left them — nothing was lost during the recovery window.</p>
        <p>If you didn't restore your account, change your password right away.</p>`,
      footer: `Glad you're back. — The Ivy Team`,
    }),
  };
}

export function renderDataExportReady({ firstName: fnRaw, filename, sizeMb, attached }) {
  const fn = escapeHtml(firstName(fnRaw));
  const supportEmail = process.env.EMAIL_REPLY_TO || 'hello@getivyos.com';
  const body = !attached
    ? `<p>Hi ${fn},</p>
       <p>Your data export for your Ivy account is ready — but it turned out to be a bit large to email safely (about <strong>${sizeMb || '24.5'} MB</strong>), so we couldn't attach it here.</p>
       <p>You can download the complete file any time from <strong>Account → Your data → Download my data</strong>. It includes your clients, bookings, financials, and account records.</p>
       <p>Didn't request this? Email <a href="mailto:${escapeHtml(supportEmail)}" style="color:#CFFF50;text-decoration:underline;">${escapeHtml(supportEmail)}</a> right away.</p>`
    : `<p>Hi ${fn},</p>
       <p>Your data export for your Ivy account is ready. It's attached to this email as <strong>${escapeHtml(filename || 'ivy-export-2026-06-22.json')}</strong> (${sizeMb || '3.2'} MB of JSON) and includes your clients, bookings, financials, and account records.</p>
       <p>For your security, keep this file somewhere safe — it's a complete copy of your data.</p>
       <p>Didn't request this? Email <a href="mailto:${escapeHtml(supportEmail)}" style="color:#CFFF50;text-decoration:underline;">${escapeHtml(supportEmail)}</a> right away.</p>`;
  return {
    subject: 'Your Ivy data export is ready',
    html: emailShell({
      heading: 'Your data export is ready',
      preheader: attached === false ? 'Download instructions inside.' : 'Download attached.',
      body,
      footer: `Requested from your account on ${new Date().toUTCString()}. — The Ivy Team`,
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────
// Admin invites (api/admin/users.js subject/body variants)
// ─────────────────────────────────────────────────────────────────────

function renderAdminInvite({ kind, firstName: fnRaw, name }) {
  const fn = escapeHtml(firstName(fnRaw));
  const greet = name ? `Hi ${fn},` : 'Hi,';
  const subjects = {
    sponsored:        "You've got a sponsored Ivy account",
    beta:             "You're invited to the Ivy beta",
    affiliate:        "Welcome to the Ivy affiliate program",
    'business-trial': "Your Ivy account is ready - 14-day trial activated",
    'business-active':"Your Ivy account is ready",
    regular:          'Welcome to Ivy',
  };
  const bodies = {
    sponsored: `<p>${greet}</p>
      <p>You've been given full access to Ivy - no subscription needed. Treat it like the paid version: the calendar, clients, invoicing, AI assistant, all of it. Set your password below and you're in.</p>`,
    beta: `<p>${greet}</p>
      <p>You've been invited to the <strong>Ivy beta</strong> — early access to the full app with no subscription and no card needed. You get the same toolset paying customers do (clients, calendar, invoicing, documents, messaging, Ivy your AI assistant, the whole thing), free for the duration of the beta.</p>
      <p>In return, we'd love your honest feedback as you use it — what works, what's broken, what's missing. Just reply to any Ivy email and it reaches a real person.</p>
      <p>Set your password below to get started.</p>`,
    affiliate: `<p>${greet}</p>
      <p>Welcome to the Ivy affiliate program. You've got a referral code that earns you credit on every business that signs up through it. Set your password and the code will be waiting for you in your account.</p>`,
    'business-trial': `<p>${greet}</p>
      <p>Your Ivy account is set up. You're on a 14-day full-access trial - long enough to actually run a couple weeks of bookings and see if the numbers move. Set your password to get in.</p>`,
    'business-active': `<p>${greet}</p>
      <p>Your Ivy account is set up and active. Pick a password below and you're ready to use the app.</p>`,
    regular: `<p>${greet}</p>
      <p>Welcome to Ivy. Set your password to start using the app.</p>`,
  };
  return {
    subject: subjects[kind] || subjects.regular,
    html: emailShell({
      heading: greet,
      body: bodies[kind] || bodies.regular,
      ctaText: 'Set my password',
      ctaUrl: `${appUrl()}/reset-password?token=PREVIEW_TOKEN_xxxxxxxx`,
      footer: `If you weren't expecting this, you can ignore this email - your account stays put until you set a password.`,
    }),
  };
}
export const renderAdminInviteSponsored      = (args) => renderAdminInvite({ ...args, kind: 'sponsored' });
export const renderAdminInviteBeta           = (args) => renderAdminInvite({ ...args, kind: 'beta' });
export const renderAdminInviteAffiliate      = (args) => renderAdminInvite({ ...args, kind: 'affiliate' });
export const renderAdminInviteBusinessTrial  = (args) => renderAdminInvite({ ...args, kind: 'business-trial' });
export const renderAdminInviteBusinessActive = (args) => renderAdminInvite({ ...args, kind: 'business-active' });

// ─────────────────────────────────────────────────────────────────────
// Booking (end-customer, white-labeled)
// ─────────────────────────────────────────────────────────────────────

function bookingDetailTable({ serviceName, dateLabel, timeLabel, locationAddress, notes }) {
  return `<table role="presentation" cellpadding="0" cellspacing="0"
    style="margin:18px 0;border-collapse:collapse;font-size:14px;line-height:1.55;">
    <tr><td style="padding:6px 16px 6px 0;color:#8A8D85;">Service</td><td style="padding:6px 0;font-weight:600;color:#F3F3EE;">${escapeHtml(serviceName)}</td></tr>
    <tr><td style="padding:6px 16px 6px 0;color:#8A8D85;">Date</td><td style="padding:6px 0;font-weight:600;color:#F3F3EE;">${escapeHtml(dateLabel)}</td></tr>
    <tr><td style="padding:6px 16px 6px 0;color:#8A8D85;">Time</td><td style="padding:6px 0;font-weight:600;color:#F3F3EE;">${escapeHtml(timeLabel)}</td></tr>
    ${locationAddress ? `<tr><td style="padding:6px 16px 6px 0;color:#8A8D85;vertical-align:top;">Where</td><td style="padding:6px 0;color:#F3F3EE;">${escapeHtml(locationAddress)}</td></tr>` : ''}
    ${notes ? `<tr><td style="padding:6px 16px 6px 0;color:#8A8D85;vertical-align:top;">Note</td><td style="padding:6px 0;color:#F3F3EE;">${escapeHtml(notes)}</td></tr>` : ''}
  </table>`;
}

export function renderBookingConfirmationClient({
  clientName, businessName, serviceName, dateLabel, timeLabel, locationAddress, notes, branding,
}) {
  const greeting = clientName ? `Hi ${escapeHtml(firstName(clientName))},` : 'Hi,';
  const biz = escapeHtml(businessName || SAMPLE_BRANDING.businessName);
  return {
    subject: `Booking confirmed - ${dateLabel}`,
    html: emailShell({
      heading: 'Booking confirmed',
      body: `<p>${greeting}</p>
        <p>Your booking with <strong>${biz}</strong> is confirmed.</p>
        ${bookingDetailTable({ serviceName, dateLabel, timeLabel, locationAddress, notes })}
        <p>Need to reschedule or message ${biz}? Open your portal any time.</p>`,
      ctaText: 'Open my portal',
      ctaUrl: `${appUrl()}/me`,
      footer: `If you didn't make this booking, please reach out to ${biz} directly.`,
      branding: branding || SAMPLE_BRANDING,
    }),
  };
}

export function renderBookingReminder({
  clientName, businessName, serviceName, dateLabel, timeLabel, locationAddress, when, branding,
}) {
  const greeting = clientName ? `Hi ${escapeHtml(firstName(clientName))},` : 'Hi,';
  const biz = escapeHtml(businessName || SAMPLE_BRANDING.businessName);
  return {
    subject: `Reminder: ${serviceName} ${when || 'tomorrow'} - ${dateLabel}`,
    html: emailShell({
      heading: 'Booking reminder',
      body: `<p>${greeting}</p>
        <p>Quick reminder of your upcoming booking with <strong>${biz}</strong>:</p>
        ${bookingDetailTable({ serviceName, dateLabel, timeLabel, locationAddress })}
        <p>See you ${when || 'soon'}. Need to reschedule? Open your portal.</p>`,
      ctaText: 'View / reschedule',
      ctaUrl: `${appUrl()}/me`,
      footer: `Replying to this email reaches ${biz} directly.`,
      branding: branding || SAMPLE_BRANDING,
    }),
  };
}

export function renderBookingCancellationClient({
  clientName, businessName, serviceName, dateLabel, branding,
}) {
  const greeting = clientName ? `Hi ${escapeHtml(firstName(clientName))},` : 'Hi,';
  const biz = escapeHtml(businessName || SAMPLE_BRANDING.businessName);
  return {
    subject: `Cancelled: ${serviceName} on ${dateLabel}`,
    html: emailShell({
      heading: 'Booking cancelled',
      body: `<p>${greeting}</p>
        <p>Your booking with <strong>${biz}</strong> on <strong>${escapeHtml(dateLabel)}</strong> has been cancelled.</p>
        <p>Want to rebook? You can pick a new time from their booking page any time.</p>`,
      ctaText: 'Rebook',
      ctaUrl: `${appUrl()}/me`,
      footer: `Questions? Just reply — this email goes straight to ${biz}.`,
      branding: branding || SAMPLE_BRANDING,
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────
// Invoicing (end-customer, white-labeled)
// ─────────────────────────────────────────────────────────────────────

function invoiceLineItemsTable(items) {
  const rows = (items || []).map((i) => `
    <tr style="border-top:1px solid #262A2D;">
      <td style="padding:8px 12px;color:#F3F3EE;font-size:13.5px;">${escapeHtml(i.description || i.name || '')}</td>
      <td style="padding:8px 12px;color:#C9CAC3;font-size:13.5px;text-align:right;white-space:nowrap;">${i.quantity || 1} × ${fmtMoney(i.rate || i.price || 0)}</td>
      <td style="padding:8px 12px;color:#F3F3EE;font-size:13.5px;font-weight:600;text-align:right;white-space:nowrap;">${fmtMoney((i.quantity || 1) * (i.rate || i.price || 0))}</td>
    </tr>`).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0;border-collapse:collapse;">${rows}</table>`;
}

export function renderInvoiceSent({
  clientName, businessName, number, total, dueDate, items, viewUrl, branding,
}) {
  const greeting = clientName ? `Hi ${escapeHtml(firstName(clientName))},` : 'Hi,';
  const biz = escapeHtml(businessName || SAMPLE_BRANDING.businessName);
  return {
    subject: `Invoice ${number || 'INV-1042'} from ${businessName || SAMPLE_BRANDING.businessName} · ${fmtMoney(total)}`,
    html: emailShell({
      heading: `Invoice ${escapeHtml(number || 'INV-1042')}`,
      body: `<p>${greeting}</p>
        <p>You have a new invoice from <strong>${biz}</strong> for <strong>${fmtMoney(total)}</strong>${dueDate ? `, due <strong>${escapeHtml(fmtDateShort(dueDate))}</strong>` : ''}.</p>
        ${invoiceLineItemsTable(items)}
        <p>You can pay it in a couple of taps using the button below.</p>`,
      ctaText: 'View & pay invoice',
      ctaUrl: viewUrl || `${appUrl()}/invoice/PREVIEW_TOKEN_xxxxxxxx`,
      footer: `Questions? Just reply — this email goes straight to ${biz}.`,
      branding: branding || SAMPLE_BRANDING,
    }),
  };
}

export function renderInvoicePaidReceipt({
  clientName, businessName, number, amount, method, branding,
}) {
  const greeting = clientName ? `Hi ${escapeHtml(firstName(clientName))},` : 'Hi,';
  const biz = escapeHtml(businessName || SAMPLE_BRANDING.businessName);
  return {
    subject: `Receipt: invoice ${number || 'INV-1042'} · ${fmtMoney(amount)}`,
    html: emailShell({
      heading: 'Payment received',
      body: `<p>${greeting}</p>
        <p>Thanks - we received your payment of <strong>${fmtMoney(amount)}</strong> for invoice <strong>${escapeHtml(number || 'INV-1042')}</strong>${method && method !== 'other' ? ` (paid by ${escapeHtml(method)})` : ''}.</p>
        <p>This email is your receipt.</p>`,
      footer: `Need anything? Reply to this email to reach ${biz}.`,
      branding: branding || SAMPLE_BRANDING,
    }),
  };
}

export function renderInvoiceOverdue({
  clientName, businessName, number, total, dueDate, daysOverdue, viewUrl, branding,
}) {
  const greeting = clientName ? `Hi ${escapeHtml(firstName(clientName))},` : 'Hi,';
  const biz = escapeHtml(businessName || SAMPLE_BRANDING.businessName);
  return {
    subject: `Reminder: invoice ${number || 'INV-1042'} is overdue`,
    html: emailShell({
      heading: `Invoice ${escapeHtml(number || 'INV-1042')} is overdue`,
      body: `<p>${greeting}</p>
        <p>This is a friendly reminder that invoice <strong>${escapeHtml(number || 'INV-1042')}</strong> for <strong>${fmtMoney(total)}</strong> is${dueDate ? ` past due (was due ${escapeHtml(fmtDateShort(dueDate))}, ${daysOverdue || 5} day${daysOverdue === 1 ? '' : 's'} overdue)` : ' overdue'}.</p>
        <p>If you've already paid, please ignore - it can take a day or two to clear.</p>`,
      ctaText: 'Open invoice',
      ctaUrl: viewUrl || `${appUrl()}/invoice/PREVIEW_TOKEN_xxxxxxxx`,
      footer: `Reply to this email if there's anything to flag.`,
      branding: branding || SAMPLE_BRANDING,
    }),
  };
}

export function renderInvoiceDueSoon({
  clientName, businessName, number, total, dueDate, daysUntilDue, viewUrl, branding,
}) {
  const greeting = clientName ? `Hi ${escapeHtml(firstName(clientName))},` : 'Hi,';
  const biz = escapeHtml(businessName || SAMPLE_BRANDING.businessName);
  const whenLabel = daysUntilDue <= 0 ? 'today'
    : daysUntilDue === 1 ? 'tomorrow'
    : `in ${daysUntilDue || 3} days`;
  return {
    subject: `Reminder: invoice ${number || 'INV-1042'} is due ${whenLabel}`,
    html: emailShell({
      heading: `A quick heads-up on invoice ${escapeHtml(number || 'INV-1042')}`,
      body: `<p>${greeting}</p>
        <p>Just a friendly reminder that invoice <strong>${escapeHtml(number || 'INV-1042')}</strong> for <strong>${fmtMoney(total)}</strong> is due <strong>${whenLabel}</strong>${dueDate ? ` (${escapeHtml(fmtDateShort(dueDate))})` : ''}.</p>
        <p>You can pay it in a couple of taps using the button below. If you've already taken care of it, thank you - no need to do anything.</p>`,
      ctaText: 'View & pay invoice',
      ctaUrl: viewUrl || `${appUrl()}/invoice/PREVIEW_TOKEN_xxxxxxxx`,
      footer: `Questions? Just reply to this email to reach ${biz}.`,
      branding: branding || SAMPLE_BRANDING,
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────
// Lead instant reply (api/_lib/leadNotify.js parallel)
// ─────────────────────────────────────────────────────────────────────

export function renderLeadInstantReply({ leadName, businessName, bookingSlug, branding }) {
  const fn = firstName(leadName);
  const biz = escapeHtml(businessName || SAMPLE_BRANDING.businessName);
  const bookingUrl = bookingSlug ? `${appUrl()}/book/${bookingSlug}` : `${appUrl()}/book/example-handle`;
  return {
    subject: `Thanks for reaching out to ${businessName || SAMPLE_BRANDING.businessName}`,
    html: emailShell({
      heading: `Thanks for reaching out`,
      body: `<p>Thanks for reaching out, ${escapeHtml(fn)}! Your message came through and <strong>${biz}</strong> will personally get back to you shortly.</p>
        <p>If you'd like, you can grab a time on the calendar right now using the button below - otherwise, sit tight and we'll be in touch.</p>`,
      ctaText: 'Book a time',
      ctaUrl: bookingUrl,
      footer: `This is an automatic confirmation that ${biz} received your message. Replying goes straight to them.`,
      branding: branding || SAMPLE_BRANDING,
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────
// Review request (api/cron/review-requests.js parallel)
// ─────────────────────────────────────────────────────────────────────

export function renderReviewRequest({ clientName, businessName, serviceName, branding }) {
  const greeting = clientName ? `Hi ${escapeHtml(firstName(clientName))},` : 'Hi,';
  const biz = escapeHtml(businessName || SAMPLE_BRANDING.businessName);
  const svc = escapeHtml(serviceName || 'session');
  const stars = (n) => Array.from({ length: 5 }, (_, i) => `
    <a href="${appUrl()}/review/PREVIEW_TOKEN_xxxxxxxx?rating=${i + 1}"
       style="display:inline-block;padding:8px 12px;font-size:24px;color:${i < n ? '#CFFF50' : '#5F625C'};text-decoration:none;">★</a>`).join('');
  return {
    subject: `How was your ${svc}?`,
    html: emailShell({
      heading: `How was your ${svc}?`,
      body: `<p>${greeting}</p>
        <p>Thanks for visiting <strong>${biz}</strong>. Would you mind sharing how it went? Tap a rating below.</p>
        <div style="text-align:center;margin:18px 0;">${stars(0)}</div>
        <p style="color:#8A8D85;font-size:12.5px;">It takes about 10 seconds. Honest feedback helps the business improve and helps other clients pick the right service.</p>`,
      footer: `Reply if you'd rather share feedback privately. — ${biz}`,
      branding: branding || SAMPLE_BRANDING,
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────
// Admin deliverability test (api/admin/email-test.js parallel)
// ─────────────────────────────────────────────────────────────────────

export function renderAdminDeliverabilityTest() {
  return {
    subject: 'Ivy deliverability test',
    html: emailShell({
      heading: 'Deliverability test',
      body: `<p>This is a deliverability test from Ivy at <strong>${new Date().toUTCString()}</strong>.</p>
        <p>If you're reading this in your inbox (not Spam), your Resend domain is configured correctly: SPF, DKIM, and DMARC are passing and the From address is verified.</p>
        <p>If this landed in Spam, check Resend → Domains and make sure every DNS record is green.</p>`,
      footer: `Sent from the admin Settings card. — Ivy`,
    }),
  };
}
