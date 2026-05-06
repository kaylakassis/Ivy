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

// ─────────────────────────────────────────────────────────────────────
// Branded email shell
// ─────────────────────────────────────────────────────────────────────
//
// Visual goal: match the THRYVE marketing site & app's "calm" theme so
// the emails feel continuous with the product instead of a random
// transactional template.
//
// Why every CSS rule lives inline (not <style>):
//   Gmail strips <style> in the message body for many client versions,
//   Outlook 2007-2019 ignores almost all <style>, and Yahoo/AOL behave
//   inconsistently. Inline styles render in every client we care about
//   without needing to maintain two parallel versions. The single
//   <style> block in <head> below is for prefers-color-scheme: dark
//   (auto-flip when the recipient's client is in dark mode), which
//   gracefully no-ops in clients that don't support it.
//
// Layout uses tables instead of divs for the same reason: Outlook on
// Windows still uses the Word HTML rendering engine, which silently
// breaks margin/padding on block elements outside of <td>. Tables are
// the lowest-common-denominator that renders identically everywhere.
//
// Optional `branding` ({ businessName, logoUrl, accentColor, emailSignature })
// applies the workspace owner's chosen presentation. When absent or
// partially set, the shell falls back to THRYVE defaults.
export function emailShell({ heading, body, ctaText, ctaUrl, footer, branding }) {
  const accent = sanitizeColor(branding?.accentColor) || '#2E3168';
  const accentInk = '#FFFFFF';
  const businessName = (branding?.businessName || '').trim();
  const logoUrl = sanitizeUrl(branding?.logoUrl);
  const sig = (branding?.emailSignature || '').trim();

  // Brand tokens — mirror tokens.css ".dir-calm". Hard-coded because
  // email clients can't read CSS variables.
  const C = {
    page:         '#F6F5F1',
    surface:      '#FFFFFF',
    surface2:     '#FAF8F3',
    border:       '#E8E4DC',
    borderStrong: '#D9D3C6',
    fg:           '#141414',
    fg2:          '#3F3D38',
    muted:        '#6E6A62',
    muted2:       '#A9A59B',
  };
  const fontDisplay = `'Fraunces','Iowan Old Style',Georgia,serif`;
  const fontSans    = `-apple-system,BlinkMacSystemFont,'Segoe UI','Inter',Helvetica,Arial,sans-serif`;

  // Letterhead: logo > business name > THRYVE wordmark. The "OS" /
  // "Business OS" subtitle is dropped when a workspace is branded so
  // the recipient sees the actual business as the sender.
  const headerLeft = logoUrl
    ? `<img src="${logoUrl}" alt="${escapeAttr(businessName || 'Logo')}"
         style="max-height:36px;max-width:180px;width:auto;height:auto;display:block;border:0;"/>`
    : (businessName
       ? `<div style="font-family:${fontDisplay};font-size:22px;letter-spacing:-0.02em;font-weight:500;color:${C.fg};line-height:1;">${escapeText(businessName)}</div>`
       : `<table role="presentation" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td style="vertical-align:middle;padding-right:10px;">
                <div style="width:30px;height:30px;border-radius:8px;background:${accent};text-align:center;line-height:30px;">
                  <span style="font-family:${fontDisplay};font-weight:600;font-size:15px;color:${accentInk};">t</span>
                </div>
              </td>
              <td style="vertical-align:middle;">
                <div style="font-family:${fontDisplay};font-size:21px;letter-spacing:-0.02em;font-weight:500;color:${C.fg};line-height:1;">thryve</div>
              </td>
            </tr>
          </table>`);

  const headerRight = businessName
    ? '' // workspaces don't show "Business OS" tag; their name IS the brand
    : `<div style="font-size:10px;letter-spacing:0.14em;text-transform:uppercase;font-weight:700;color:${C.muted};text-align:right;">Business OS</div>`;

  // CTA button. Bulletproof double-table pattern so Outlook + Gmail +
  // Apple Mail all render the same pill. The link is wrapped twice so
  // the click target fills the padded area.
  const cta = ctaText && ctaUrl
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0 4px;">
         <tr>
           <td align="center" bgcolor="${accent}"
               style="border-radius:10px;background:${accent};">
             <a href="${ctaUrl}"
                style="display:inline-block;padding:14px 28px;font-family:${fontSans};font-size:14.5px;font-weight:600;color:${accentInk};text-decoration:none;border-radius:10px;letter-spacing:-0.005em;line-height:1;">
               ${escapeText(ctaText)}
             </a>
           </td>
         </tr>
       </table>
       <div style="font-size:11.5px;color:${C.muted};line-height:1.55;margin-top:14px;">
         Trouble with the button? Paste this link into your browser:
       </div>
       <div style="font-size:11.5px;color:${C.fg2};line-height:1.55;word-break:break-all;margin-top:2px;">
         <a href="${ctaUrl}" style="color:${C.fg2};text-decoration:underline;">${escapeText(ctaUrl)}</a>
       </div>`
    : '';

  const sigBlock = sig
    ? `<div style="font-size:13px;color:${C.fg2};line-height:1.65;margin:28px 0 0;white-space:pre-wrap;">${escapeText(sig)}</div>`
    : '';

  const footerByline = businessName
    ? `Sent by <strong style="color:${C.fg2};">${escapeText(businessName)}</strong> via THRYVE`
    : `Made with care · <a href="https://getthryve.ai" style="color:${C.muted};text-decoration:none;">getthryve.ai</a>`;

  // Dark-mode rule lives in a single <style> in <head>. Apple Mail,
  // recent Gmail, recent Outlook honor it; everywhere else it
  // silently falls back to the calm theme — that's fine.
  const darkBlock = `
    <style>
      @media (prefers-color-scheme: dark) {
        body, table { background:#0D0E0C !important; }
        .thryve-card     { background:#16181A !important; border-color:#262A2D !important; }
        .thryve-band     { background:#1D2022 !important; border-color:#262A2D !important; }
        .thryve-fg       { color:#F3F3EE !important; }
        .thryve-fg2      { color:#C9CAC3 !important; }
        .thryve-muted    { color:#8A8D85 !important; }
        .thryve-muted2   { color:#5F625C !important; }
        .thryve-link     { color:#C9CAC3 !important; }
      }
    </style>
  `;

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <meta name="color-scheme" content="light dark"/>
  <meta name="supported-color-schemes" content="light dark"/>
  <title>${escapeText(heading || 'THRYVE')}</title>
  ${darkBlock}
</head>
<body style="margin:0;padding:0;background:${C.page};font-family:${fontSans};color:${C.fg};-webkit-font-smoothing:antialiased;mso-line-height-rule:exactly;">
  <!-- Hidden preheader: shows as the inbox-list preview text. -->
  <div style="display:none;font-size:1px;color:${C.page};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escapeText(stripHtml(body || '').slice(0, 110))}</div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.page};">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"
               class="thryve-card"
               style="max-width:600px;width:100%;background:${C.surface};border:1px solid ${C.border};border-radius:16px;overflow:hidden;box-shadow:0 1px 2px rgba(20,14,0,0.04),0 12px 32px -16px rgba(20,14,0,0.10);">

          <!-- Letterhead band -->
          <tr>
            <td class="thryve-band"
                style="padding:18px 28px;background:${C.surface2};border-bottom:1px solid ${C.border};">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="vertical-align:middle;">${headerLeft}</td>
                  <td style="vertical-align:middle;text-align:right;">${headerRight}</td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:36px 32px 28px;">
              <h1 class="thryve-fg"
                  style="margin:0 0 18px;font-family:${fontDisplay};font-size:26px;letter-spacing:-0.025em;font-weight:500;line-height:1.2;color:${C.fg};">
                ${heading}
              </h1>
              <div class="thryve-fg2"
                   style="font-size:15px;line-height:1.7;color:${C.fg2};">
                ${body}
              </div>
              ${cta}
              ${sigBlock}
            </td>
          </tr>

          ${footer ? `
          <!-- Inline footer (caller-supplied legalese) -->
          <tr>
            <td style="padding:0 32px 28px;">
              <hr style="border:0;border-top:1px solid ${C.border};margin:0 0 16px;"/>
              <div class="thryve-muted"
                   style="font-size:12px;color:${C.muted};line-height:1.6;">
                ${footer}
              </div>
            </td>
          </tr>
          ` : ''}

          <!-- Brand stripe at the very bottom -->
          <tr>
            <td class="thryve-band"
                style="padding:16px 28px;background:${C.surface2};border-top:1px solid ${C.border};text-align:center;">
              <div class="thryve-muted2"
                   style="font-size:11px;color:${C.muted2};letter-spacing:0.04em;">
                ${footerByline}
              </div>
            </td>
          </tr>
        </table>

        <!-- Tagline below the card. Tiny, no boilerplate. -->
        <div class="thryve-muted2"
             style="margin-top:16px;font-size:11px;color:${C.muted2};line-height:1.5;max-width:600px;">
          THRYVE is the all-in-one business OS for solo entrepreneurs.<br/>
          One workspace · clients, calendar, invoices, messages, docs.
        </div>
      </td>
    </tr>
  </table>
</body>
</html>`;
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
