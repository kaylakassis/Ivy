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
import { sendEmailToClientByAddress, emailShell } from './email.js';
import { fetchBranding } from './branding.js';
import { appUrl } from './tokens.js';
import { reportError } from './monitoring.js';
import { countRecent, recordAttempt } from './rate-limit.js';
import { createHash } from 'node:crypto';

// Daily caps on automatic replies, on top of the callers' per-IP limits.
// Per-IP limits don't stop someone spreading submissions over many IPs to
// make a business's address send hundreds of emails (hurting its sender
// reputation), or to flood one person's inbox using a business as the
// relay. Over a cap the lead is still recorded and the owner still told;
// only the auto-reply is skipped. Counted in rate_limits (rolling 24h,
// same table as api/_lib/rate-limit.js); the recipient key holds a hash,
// never the address.
export const LEAD_REPLY_MAX_PER_BUSINESS_PER_DAY = 50;
export const LEAD_REPLY_MAX_PER_RECIPIENT_PER_DAY = 2;
const DAY_SECONDS = 24 * 60 * 60;

function capKeys(workspaceId, email) {
  const h = createHash('sha256').update(String(email).trim().toLowerCase()).digest('hex').slice(0, 32);
  return {
    business: `lead-autoreply:ws:${workspaceId}`,
    recipient: `lead-autoreply:ws:${workspaceId}:to:${h}`,
  };
}

// Check both caps and, when under them, count this reply. Returns the
// reason to skip, or null to go ahead.
async function takeAutoReplySlot(workspaceId, email) {
  const keys = capKeys(workspaceId, email);
  const [biz, rcpt] = await Promise.all([
    countRecent(keys.business, DAY_SECONDS),
    countRecent(keys.recipient, DAY_SECONDS),
  ]);
  if (rcpt.count >= LEAD_REPLY_MAX_PER_RECIPIENT_PER_DAY) return 'recipient-daily-cap';
  if (biz.count >= LEAD_REPLY_MAX_PER_BUSINESS_PER_DAY) return 'business-daily-cap';
  await Promise.all([recordAttempt(keys.business), recordAttempt(keys.recipient)]);
  return null;
}

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
    const capped = await takeAutoReplySlot(workspaceId, toEmail);
    if (capped) return { sent: false, reason: capped };
    const branding = await fetchBranding(workspaceId);
    const business = branding.businessName || 'us';
    const firstName = (leadName || '').split(/\s+/)[0] || '';
    const bookingUrl = cfg?.slug ? `${appUrl()}/book/${cfg.slug}` : appUrl();

    const custom = (cfg?.lead_instant_reply_message || '').trim();
    const bodyText = custom
      ? renderMessage(custom, { firstName, businessName: business })
      : `Thanks for reaching out${firstName ? `, ${firstName}` : ''}! Your message came through and ${business} will personally get back to you shortly.\n\nIf you'd like, you can grab a time on the calendar right now using the button below - otherwise, sit tight and we'll be in touch.`;

    // Render plain text into safe paragraphs (newlines → breaks). bodyText
    // is RAW text (both branches): it is escaped here, exactly once.
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

    // Optional auto-reply, not something the person must get: an address
    // that unsubscribed from this business's message emails (or from all
    // of them) gets nothing, and every reply carries an unsubscribe link.
    const r = await sendEmailToClientByAddress({
      workspaceId,
      email: toEmail,
      type: 'messages',
      subject: `Thanks for reaching out to ${business}`,
      html,
      replyTo: branding.replyTo,
    });
    if (!r.sent) return { sent: false, reason: r.reason };
    return { sent: true };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[notifyLeadInstantReply] failed:', err.message);
    reportError(err, { extra: { workspaceId } });
    return { sent: false, reason: err.message };
  }
}
