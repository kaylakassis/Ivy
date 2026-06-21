// Lead instant reply.
//
// When a prospect submits the owner's website contact form, send them an
// immediate white-labeled acknowledgement with the owner's booking link -
// so an inbound lead never sits unanswered while the owner is away. The
// reply complements (doesn't replace) the owner's personal follow-up.
//
// Per-workspace controls live on calendar_settings:
//   • lead_instant_reply_enabled (default TRUE)
//   • lead_instant_reply_message (NULL = use the default copy below)
//
// Best-effort: catches internally, never throws.
import { sql } from './db.js';
import { sendEmail, emailShell } from './email.js';
import { fetchBranding } from './branding.js';
import { appUrl } from './tokens.js';
import { reportError } from './monitoring.js';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Find a usable email + best-guess name out of an arbitrary form payload
// (keys vary: email/Email/emailAddress, name/Name/fullName/first_name…).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function extractLeadContact(payload = {}) {
  if (!payload || typeof payload !== 'object') return { email: null, name: '' };
  let email = null;
  let name = '';
  for (const [k, v] of Object.entries(payload)) {
    if (typeof v !== 'string') continue;
    const key = k.toLowerCase();
    if (!email && /e-?mail/.test(key) && EMAIL_RE.test(v.trim())) email = v.trim();
    if (!name && /(^name$|full.?name|your.?name|first.?name|fname)/.test(key)) name = v.trim();
  }
  // Fallback: any value that looks like an email.
  if (!email) {
    for (const v of Object.values(payload)) {
      if (typeof v === 'string' && EMAIL_RE.test(v.trim())) { email = v.trim(); break; }
    }
  }
  return { email: email ? email.toLowerCase().slice(0, 200) : null, name: name.slice(0, 120) };
}

function renderMessage(tpl, { firstName, businessName }) {
  return String(tpl)
    .replace(/\{\{\s*firstName\s*\}\}/gi, firstName || 'there')
    .replace(/\{\{\s*businessName\s*\}\}/gi, businessName || 'us');
}

// workspaceId + the lead's email/name. Reads the per-workspace toggle and
// fires the acknowledgement. Returns { sent: boolean, reason?: string }.
export async function notifyLeadInstantReply({ workspaceId, toEmail, leadName }) {
  try {
    if (!workspaceId || !toEmail || !EMAIL_RE.test(toEmail)) {
      return { sent: false, reason: 'no-recipient' };
    }
    const { rows } = await sql`
      SELECT slug, lead_instant_reply_enabled, lead_instant_reply_message
        FROM calendar_settings WHERE workspace_id = ${workspaceId}
    `;
    const cfg = rows[0];
    // Default ON: only skip when explicitly disabled.
    if (cfg && cfg.lead_instant_reply_enabled === false) {
      return { sent: false, reason: 'disabled' };
    }
    const branding = await fetchBranding(workspaceId);
    const business = branding.businessName || 'us';
    const firstName = (leadName || '').split(/\s+/)[0] || '';
    const bookingUrl = cfg?.slug ? `${appUrl()}/book/${cfg.slug}` : appUrl();

    const custom = (cfg?.lead_instant_reply_message || '').trim();
    const bodyText = custom
      ? renderMessage(custom, { firstName, businessName: business })
      : `Thanks for reaching out${firstName ? `, ${firstName}` : ''}! Your message came through and ${escapeHtml(business)} will personally get back to you shortly.\n\nIf you'd like, you can grab a time on the calendar right now using the button below - otherwise, sit tight and we'll be in touch.`;

    // Render plain text into safe paragraphs (newlines → breaks).
    const bodyHtml = bodyText
      .split(/\n{2,}/)
      .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br/>')}</p>`)
      .join('');

    const html = emailShell({
      heading: `Thanks for reaching out`,
      branding,
      body: bodyHtml,
      ctaText: cfg?.slug ? 'Book a time' : undefined,
      ctaUrl: cfg?.slug ? bookingUrl : undefined,
      footer: `This is an automatic confirmation that ${escapeHtml(business)} received your message. Replying goes straight to them.`,
    });

    await sendEmail({
      to: toEmail,
      subject: `Thanks for reaching out to ${business}`,
      html,
      replyTo: branding.replyTo,
    });
    return { sent: true };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[notifyLeadInstantReply] failed:', err.message);
    reportError(err, { extra: { workspaceId } });
    return { sent: false, reason: err.message };
  }
}
