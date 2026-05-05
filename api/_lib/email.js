// Resend wrapper. Sends transactional email (verification, password reset).
// Env:
//   RESEND_API_KEY (required)
//   EMAIL_FROM     (defaults to onboarding@resend.dev — Resend's sandbox.
//                   Works for sending to your own verified-on-Resend email
//                   only. Replace once you've verified your own domain in
//                   Resend dashboard.)
//   EMAIL_REPLY_TO (optional — where replies should route)
//
// Production setup once you have a domain:
//   1. Add your domain in https://resend.com/domains and finish the DNS
//      records they list (SPF, DKIM, DMARC). Status must read "Verified".
//   2. Set EMAIL_FROM='THRYVE <noreply@your-domain.com>' in Vercel envs.
//   3. Set EMAIL_REPLY_TO='support@your-domain.com'.
//   4. Hit /account → Admin → "Check email-domain status" to confirm
//      Resend reports the domain as verified.

const RESEND_URL = 'https://api.resend.com/emails';

function fromAddress() {
  return process.env.EMAIL_FROM || 'THRYVE <onboarding@resend.dev>';
}

function replyToAddress() {
  return process.env.EMAIL_REPLY_TO || null;
}

function fromDomain() {
  // Pull "user@domain.tld" out of either bare or "Name <addr>" form.
  const raw = fromAddress();
  const m = raw.match(/<([^>]+)>/) || [null, raw];
  return (m[1] || '').split('@').pop()?.toLowerCase().trim();
}

let _warnedSandbox = false;
function warnIfSandbox() {
  // Light warning so the operator notices in function logs that they're
  // on the resend.dev sandbox, but DON'T block the send — Resend's
  // sandbox does deliver to verified Resend-account addresses, which
  // is enough to test signup-verification flows in production before a
  // custom domain is ready.
  if (_warnedSandbox) return;
  if (!process.env.EMAIL_FROM || fromDomain() === 'resend.dev') {
    // eslint-disable-next-line no-console
    console.warn('[email] EMAIL_FROM not set (or resend.dev). Resend will only deliver to your own verified Resend-account address. Set EMAIL_FROM to a verified custom-domain sender for full delivery.');
    _warnedSandbox = true;
  }
}

export async function sendEmail({ to, subject, html, text, replyTo, headers }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY not set');
  warnIfSandbox();

  const body = {
    from: fromAddress(),
    to: Array.isArray(to) ? to : [to],
    subject,
    html,
    text: text || stripHtml(html),
  };

  // Reply-To: explicit override > env default > skip.
  const reply = replyTo || replyToAddress();
  if (reply) body.reply_to = reply;

  // Allow callers to pass extra headers (e.g. List-Unsubscribe for nicer
  // inbox treatment). Keys are passed through as-is.
  if (headers && typeof headers === 'object') body.headers = headers;

  const res = await fetch(RESEND_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    // Re-shape the most common Resend errors into something an operator
    // can act on directly. Surfaces in /admin → Send test email.
    if (res.status === 403 && /domain.*not.*verified|verify.*domain/i.test(detail)) {
      throw new Error(
        `Resend rejected: domain not verified. Add ${fromDomain()} at https://resend.com/domains and finish the DNS records. Until then, EMAIL_FROM='THRYVE <onboarding@resend.dev>' will only deliver to your own verified Resend-account address.`,
      );
    }
    if (res.status === 422) {
      throw new Error(`Resend 422 (validation): ${detail.slice(0, 240)}`);
    }
    throw new Error(`Resend ${res.status}: ${detail.slice(0, 240)}`);
  }
  return res.json();
}

function stripHtml(s = '') {
  return s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

// Branded-but-minimal email shell. Looks decent, won't break in any client.
//
// Optional `branding` ({ businessName, logoUrl, accentColor, emailSignature })
// applies the workspace owner's chosen presentation. When absent or
// partially set, the shell falls back to THRYVE defaults — same look
// the app shipped with before per-workspace branding existed.
export function emailShell({ heading, body, ctaText, ctaUrl, footer, branding }) {
  const accent = sanitizeColor(branding?.accentColor) || '#2E3168';
  const businessName = (branding?.businessName || '').trim();
  const logoUrl = sanitizeUrl(branding?.logoUrl);
  const sig = (branding?.emailSignature || '').trim();

  const cta = ctaText && ctaUrl
    ? `<p style="margin:32px 0;text-align:center;">
         <a href="${ctaUrl}" style="display:inline-block;padding:13px 24px;background:${accent};color:#FFFFFF;
            text-decoration:none;border-radius:10px;font-weight:550;font-size:14px;">
           ${ctaText}
         </a>
       </p>
       <p style="font-size:12px;color:#85827B;word-break:break-all;">
         Or paste this link into your browser: <br/>${ctaUrl}
       </p>`
    : '';

  // Header: owner's logo if uploaded, else owner's business name in
  // serif type, else "thryve" wordmark.
  const headerInner = logoUrl
    ? `<img src="${logoUrl}" alt="${escapeAttr(businessName || 'Logo')}"
         style="max-height:42px;max-width:200px;width:auto;height:auto;display:block;"/>`
    : (businessName
       ? `<div style="font-family:'Fraunces',Georgia,serif;font-size:22px;letter-spacing:-0.02em;font-weight:500;color:#141414;">${escapeText(businessName)}</div>`
       : `<div style="font-family:'Fraunces',Georgia,serif;font-size:22px;letter-spacing:-0.02em;font-weight:500;">thryve</div>`);

  // Owner-supplied signature renders below the body, above the
  // optional caller-supplied footer. Both go through escape: the
  // signature is treated as plain text with line breaks preserved.
  const sigBlock = sig
    ? `<div style="font-size:13px;color:#3F3D38;line-height:1.6;margin:24px 0 0;white-space:pre-wrap;">${escapeText(sig)}</div>`
    : '';

  // Bottom-of-page byline. When branded, credit the business but
  // keep a small "Sent via THRYVE" mark for accountability.
  const sentByline = businessName
    ? `Sent by ${escapeText(businessName)} via THRYVE`
    : 'Sent by THRYVE Business OS';

  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#F6F5F1;font-family:-apple-system,system-ui,'Inter',sans-serif;color:#141414;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr><td align="center">
      <table role="presentation" width="520" cellpadding="0" cellspacing="0"
             style="background:#FFFFFF;border:1px solid #E8E4DC;border-radius:14px;overflow:hidden;">
        <tr><td style="padding:32px 32px 8px;">${headerInner}</td></tr>
        <tr><td style="padding:8px 32px 32px;">
          <h1 style="margin:0 0 16px;font-family:'Fraunces',Georgia,serif;font-size:24px;letter-spacing:-0.025em;font-weight:500;line-height:1.2;">${heading}</h1>
          <div style="font-size:15px;line-height:1.6;color:#3F3D38;">${body}</div>
          ${cta}
          ${sigBlock}
          ${footer ? `<hr style="border:0;border-top:1px solid #E8E4DC;margin:32px 0 16px;"/>
                     <div style="font-size:12px;color:#85827B;line-height:1.55;">${footer}</div>` : ''}
        </td></tr>
      </table>
      <div style="font-size:11px;color:#A9A59B;margin-top:14px;">${sentByline}</div>
    </td></tr>
  </table>
</body></html>`;
}

function sanitizeColor(c) {
  if (!c || typeof c !== 'string') return null;
  const v = c.trim();
  return /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(v) ? v : null;
}
function sanitizeUrl(u) {
  if (!u || typeof u !== 'string') return null;
  const v = u.trim();
  return /^https:\/\//.test(v) ? v : null;
}
function escapeText(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeText(s); }
