// Resend wrapper. Sends transactional email (verification, password reset).
// Env:
//   RESEND_API_KEY (required)
//   EMAIL_FROM     (defaults to onboarding@resend.dev - Resend's sandbox.
//                   Works for sending to your own verified-on-Resend email
//                   only. Replace once you've verified your own domain in
//                   Resend dashboard.)
//   EMAIL_REPLY_TO (optional - where replies should route)
//
// Production setup once you have a domain:
//   1. Add your domain in https://resend.com/domains and finish the DNS
//      records they list (SPF, DKIM, DMARC). Status must read "Verified".
//   2. Set EMAIL_FROM='Ivy <noreply@your-domain.com>' in Vercel envs.
//   3. Set EMAIL_REPLY_TO='support@your-domain.com'.
//   4. Hit /account → Admin → "Check email-domain status" to confirm
//      Resend reports the domain as verified.
import { userAllowsEmail, clientAllowsEmail, clientAllowsEmailByAddress, CRITICAL_EMAIL_TYPES } from './notificationPrefs.js';
import { tryConsumeQuota, DEFAULT_EMAIL_CAP_PER_DAY } from './usageCounters.js';
import { unsubscribeUrlFor } from './unsubscribeToken.js';
import { sql } from './db.js';

const RESEND_URL = 'https://api.resend.com/emails';

// Resend's per-account rate limit is 10 requests/sec on Pro and below. A
// cron that loops sendEmail() in a tight inner loop will trip 429s well
// before that ceiling because bursts come faster than Resend admits.
// This in-process token bucket spaces sends ~125ms apart (≈8/sec sustained)
// to stay under the ceiling without throwing away throughput. Each
// serverless function invocation has its own bucket - which is fine, since
// the crons that drive heavy volume are the only callers issuing tight
// loops and they run one at a time.
const MIN_INTERVAL_MS = 125;
let lastSendAt = 0;
async function throttle() {
  const now = Date.now();
  const wait = lastSendAt + MIN_INTERVAL_MS - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastSendAt = Date.now();
}

function fromAddress() {
  return process.env.EMAIL_FROM || 'Ivy <onboarding@resend.dev>';
}

function replyToAddress() {
  return process.env.EMAIL_REPLY_TO || null;
}

// Reports the email-sending posture so handlers (notably /auth/signup)
// can surface a banner when the operator hasn't moved off the Resend
// sandbox yet. 'sandbox' = onboarding@resend.dev / no EMAIL_FROM,
// which only delivers to the Resend account-owner's verified address.
// 'unconfigured' = no RESEND_API_KEY at all; emails will throw.
export function emailSendingMode() {
  if (!process.env.RESEND_API_KEY) return 'unconfigured';
  if (!process.env.EMAIL_FROM || fromDomain() === 'resend.dev') return 'sandbox';
  return 'production';
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
  // on the resend.dev sandbox, but DON'T block the send - Resend's
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

export async function sendEmail({ to, subject, html, text, replyTo, headers, attachments, unsubscribeUrl, timeoutMs = 8000 }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY not set');
  warnIfSandbox();
  // Pace sustained loops to stay under Resend's 10/sec ceiling. Single
  // sends pay no real cost (the bucket only blocks if you've just sent
  // one); cron tight-loops space out automatically.
  await throttle();

  // Inject a visible "Unsubscribe / Manage preferences" link near the
  // bottom of every prefs-aware send. The List-Unsubscribe HEADER is
  // what Gmail / Apple Mail surface as a one-click inbox button, but a
  // chunk of clients (older Outlook, Yahoo on some platforms) don't
  // render it — recipients there need a clickable link in the body or
  // they have no opt-out at all. Done at send-time so we don't have to
  // thread unsubscribeUrl through every emailShell call site.
  const finalHtml = unsubscribeUrl ? injectUnsubFooter(html, unsubscribeUrl) : html;
  const body = {
    from: fromAddress(),
    to: Array.isArray(to) ? to : [to],
    subject,
    html: finalHtml,
    text: text || stripHtml(finalHtml),
  };

  // Reply-To: explicit override > env default > skip.
  const reply = replyTo || replyToAddress();
  if (reply) body.reply_to = reply;

  // Optional file attachments. Resend expects
  // [{ filename, content: <base64 string>, content_type? }]. We accept the
  // camelCase `contentType` for convenience and map it through.
  if (Array.isArray(attachments) && attachments.length) {
    body.attachments = attachments.map((a) => ({
      filename: a.filename,
      content: a.content,
      ...(a.contentType || a.content_type ? { content_type: a.contentType || a.content_type } : {}),
    }));
  }

  // List-Unsubscribe headers. Gmail bumps senders that don't expose a
  // one-click unsubscribe (RFC 8058, mandatory for 5K+/day senders since
  // 2024). When the caller has minted a per-recipient signed URL
  // (sendEmailToUser / sendEmailToClient etc.), use it — the /api/unsubscribe
  // endpoint handles POST one-click and applies the opt-out without
  // requiring login. Fall back to the generic prefs page + mailto for
  // bare sendEmail() callers (system-critical, no recipient lookup
  // possible) so the header is never missing.
  const httpsUnsub = unsubscribeUrl
    || `${process.env.APP_URL || 'https://getivyos.com'}/account?tab=notifications`;
  const mailtoUnsub = `mailto:${replyToAddress() || 'hello@getivyos.com'}?subject=unsubscribe`;
  const defaultHeaders = {
    'List-Unsubscribe': `<${httpsUnsub}>, <${mailtoUnsub}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
  body.headers = { ...defaultHeaders, ...(headers && typeof headers === 'object' ? headers : {}) };

  // Hard cap each Resend call so a hung connection can't drag the
  // surrounding serverless function over its budget. Resend usually
  // responds in 200-1500ms; 8s is generous and still well below the
  // signup function's 30s ceiling.
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(RESEND_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(t);
    if (err.name === 'AbortError') {
      throw new Error(`Resend timed out after ${timeoutMs}ms - request never completed.`);
    }
    throw err;
  }
  clearTimeout(t);

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    // Re-shape the most common Resend errors into something an operator
    // can act on directly. Surfaces in /admin → Send test email.
    if (res.status === 403 && /domain.*not.*verified|verify.*domain/i.test(detail)) {
      throw new Error(
        `Resend rejected: domain not verified. Add ${fromDomain()} at https://resend.com/domains and finish the DNS records. Until then, EMAIL_FROM='Ivy <onboarding@resend.dev>' will only deliver to your own verified Resend-account address.`,
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

// Append a small "Unsubscribe · Manage preferences" line just before
// </body> so every prefs-aware send carries a visible opt-out, regardless
// of which call site rendered the body. If the body is not a full HTML
// document, we tack it on the end. Idempotent on the marker so a
// double-call (test wrappers, retries) doesn't double-print the line.
const UNSUB_MARKER = 'data-ivy-unsub="1"';
function injectUnsubFooter(html, unsubscribeUrl) {
  if (!html || typeof html !== 'string') return html;
  if (html.includes(UNSUB_MARKER)) return html;
  const prefsUrl = `${process.env.APP_URL || 'https://getivyos.com'}/account?tab=notifications`;
  const block = `<div ${UNSUB_MARKER} style="margin:18px auto 0;max-width:600px;text-align:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Inter',Helvetica,Arial,sans-serif;font-size:11px;color:#8A8D85;line-height:1.5;">
    <a href="${unsubscribeUrl}" style="color:#8A8D85;text-decoration:underline;">Unsubscribe</a>
    &nbsp;·&nbsp;
    <a href="${prefsUrl}" style="color:#8A8D85;text-decoration:underline;">Manage email preferences</a>
  </div>`;
  if (/<\/body\s*>/i.test(html)) return html.replace(/<\/body\s*>/i, `${block}</body>`);
  return html + block;
}

// ─────────────────────────────────────────────────────────────────────
// Branded email shell
// ─────────────────────────────────────────────────────────────────────
//
// Visual goal: match the Ivy app's "bold" (dark) theme so every
// transactional email - verification, password reset, invoice, booking
// confirmation, doc signing, message reply - feels native to the
// product. Uses the same palette as src/styles/tokens.css `.dir-bold`:
// near-black background, lime-green accent, off-white body text.
//
// Why every CSS rule lives inline (not <style>):
//   Gmail strips <style> in the message body for many client versions,
//   Outlook 2007-2019 ignores almost all <style>, and Yahoo/AOL behave
//   inconsistently. Inline styles render in every client we care about
//   without needing to maintain two parallel versions.
//
// Layout uses tables instead of divs for the same reason: Outlook on
// Windows still uses the Word HTML rendering engine, which silently
// breaks margin/padding on block elements outside of <td>.
//
// Dark by default - the meta `color-scheme: dark only` tells Apple
// Mail / Gmail / Outlook NOT to auto-adjust contrast, which is what
// was dimming our intentionally-bright text to grey. The clients that
// don't honor it just render the inline styles as-is, which is
// already the dark theme.
//
// Optional `branding` ({ businessName, logoUrl, accentColor, emailSignature })
// applies the workspace owner's chosen presentation. accentColor (if
// set) overrides the default lime; we compute a contrasting ink color
// for button text via relative-luminance.
export function emailShell({ heading, body, ctaText, ctaUrl, footer, branding, preheader, unsubscribeUrl }) {
  // Brand tokens - mirror tokens.css ".dir-bold" exactly. Hard-coded
  // because email clients can't read CSS variables.
  const C = {
    page:         '#0D0E0C',
    surface:      '#16181A',
    surface2:     '#1D2022',
    border:       '#262A2D',
    borderStrong: '#383D41',
    fg:           '#F3F3EE',
    fg2:          '#C9CAC3',
    muted:        '#8A8D85',
    muted2:       '#5F625C',
  };
  const accent = sanitizeColor(branding?.accentColor) || '#CFFF50';
  const accentInk = pickAccentInk(accent);
  const businessName = (branding?.businessName || '').trim();
  const logoUrl = sanitizeUrl(branding?.logoUrl);
  const sig = (branding?.emailSignature || '').trim();
  const fontDisplay = `'Fraunces','Iowan Old Style',Georgia,serif`;
  const fontSans    = `-apple-system,BlinkMacSystemFont,'Segoe UI','Inter',Helvetica,Arial,sans-serif`;

  // Letterhead: logo > business name > Ivy wordmark. The "Business
  // OS" tag is dropped when a workspace is branded so the recipient
  // sees the actual business as the sender.
  const headerLeft = logoUrl
    ? `<img src="${logoUrl}" alt="${escapeAttr(businessName || 'Logo')}"
         style="max-height:36px;max-width:180px;width:auto;height:auto;display:block;border:0;"/>`
    : (businessName
       ? `<div style="font-family:${fontDisplay};font-size:22px;letter-spacing:-0.02em;font-weight:500;color:${C.fg};line-height:1;">${escapeText(businessName)}</div>`
       : `<div style="font-family:${fontDisplay};font-size:21px;letter-spacing:-0.02em;font-weight:600;color:${accent};line-height:1;">Ivy</div>`);

  const headerRight = businessName
    ? '' // workspaces don't show "Business OS" tag; their name IS the brand
    : `<div style="font-size:10px;letter-spacing:0.14em;text-transform:uppercase;font-weight:700;color:${C.muted};text-align:right;">Business OS</div>`;

  // CTA button. Bulletproof double-table pattern so Outlook + Gmail +
  // Apple Mail all render the same pill.
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
    ? `Sent by <strong style="color:${C.fg2};">${escapeText(businessName)}</strong> via Ivy`
    : `Made with care · <a href="https://getivyos.com" style="color:${C.muted};text-decoration:none;">getivyos.com</a>`;

  // CAN-SPAM postal address. Only shown on unbranded sends (i.e.
  // Ivy itself as the sender - admin blasts, magic links, account
  // emails). Per-workspace transactional emails (booking confirmations,
  // invoices, etc.) carry the owner's branding and are exempt.
  const postalAddress = !businessName
    ? (process.env.IVY_POSTAL_ADDRESS || 'Ivy · 1209 Orange St, Wilmington, DE 19801, USA')
    : '';
  const postalBlock = postalAddress
    ? `<div style="margin-top:6px;font-size:10.5px;color:${C.muted2};letter-spacing:0.02em;">${escapeText(postalAddress)}</div>`
    : '';

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <meta name="color-scheme" content="dark only"/>
  <meta name="supported-color-schemes" content="dark only"/>
  <title>${escapeText(heading || 'Ivy')}</title>
</head>
<body style="margin:0;padding:0;background:${C.page};font-family:${fontSans};color:${C.fg};-webkit-font-smoothing:antialiased;mso-line-height-rule:exactly;">
  <!-- Hidden preheader: shows as the inbox-list preview text. Explicit
       value when provided (best - the caller writes deliberate preview
       copy); otherwise derived from the first chunk of the body. -->
  <div style="display:none;font-size:1px;color:${C.page};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escapeText((preheader || stripHtml(body || '')).slice(0, 140))}</div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.page};">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"
               style="max-width:600px;width:100%;background:${C.surface};border:1px solid ${C.border};border-radius:16px;overflow:hidden;">

          <!-- Letterhead band -->
          <tr>
            <td style="padding:18px 28px;background:${C.surface2};border-bottom:1px solid ${C.border};">
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
              <h1 style="margin:0 0 18px;font-family:${fontDisplay};font-size:26px;letter-spacing:-0.025em;font-weight:500;line-height:1.2;color:${C.fg};">
                ${heading}
              </h1>
              <div style="font-size:15px;line-height:1.7;color:${C.fg};">
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
              <div style="font-size:12px;color:${C.muted};line-height:1.6;">
                ${footer}
              </div>
            </td>
          </tr>
          ` : ''}

          <!-- Brand stripe at the very bottom -->
          <tr>
            <td style="padding:16px 28px;background:${C.surface2};border-top:1px solid ${C.border};text-align:center;">
              <div style="font-size:11px;color:${C.muted2};letter-spacing:0.04em;">
                ${footerByline}
              </div>
              ${postalBlock}
              ${unsubscribeUrl
                ? `<div style="margin-top:8px;font-size:11px;color:${C.muted2};letter-spacing:0.02em;">
                     <a href="${unsubscribeUrl}" style="color:${C.muted};text-decoration:underline;">Unsubscribe</a>
                     &nbsp;·&nbsp;
                     <a href="${process.env.APP_URL || 'https://getivyos.com'}/account?tab=notifications" style="color:${C.muted};text-decoration:underline;">Manage preferences</a>
                   </div>`
                : ''}
            </td>
          </tr>
        </table>

        <!-- Tagline below the card. Tiny, no boilerplate. -->
        <div style="margin-top:16px;font-size:11px;color:${C.muted2};line-height:1.5;max-width:600px;">
          Ivy is the all-in-one business OS for solo entrepreneurs.<br/>
          One workspace · clients, calendar, invoices, messages, docs.
        </div>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// Pick a contrasting text color for buttons given the workspace's
// accent color. Bright accents (lime, yellow, light blue) get dark
// ink; dark accents (the original calm-theme #2E3168 indigo, deep
// reds, etc.) get off-white. Threshold tuned so #CFFF50 lime → dark
// ink and #2E3168 indigo → light ink.
function pickAccentInk(hex) {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex || '');
  if (!m) return '#0B0C08';
  const r = parseInt(m[1].slice(0, 2), 16);
  const g = parseInt(m[1].slice(2, 4), 16);
  const b = parseInt(m[1].slice(4, 6), 16);
  // Standard relative-luminance approximation. >140 means "bright".
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 140 ? '#0B0C08' : '#F3F3EE';
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

// ─────────────────────────────────────────────────────────────────────
// Prefs-aware send wrappers
// ─────────────────────────────────────────────────────────────────────
//
// Most callers should use one of these instead of sendEmail() directly
// so the recipient's per-type opt-out is honored.
//
// `type` must be an EMAIL_NOTIFY_TYPE (bookings, invoices, documents,
// messages, marketing, billing) OR a CRITICAL_EMAIL_TYPE (verification,
// password_reset, account_deletion). Critical types bypass prefs.
//
// Returns { ok: boolean, sent: boolean, reason?: string } so the caller
// can tell "didn't fire because muted" apart from "Resend exploded".

// Resolve "which workspace does this email count against?" for the
// per-workspace daily quota (§2.8). Critical types (verification,
// password_reset, account_deletion) bypass the cap - those MUST go
// through or the user is locked out.
async function gateByQuota(workspaceId, type) {
  if (!workspaceId) return { ok: true };
  if (type && CRITICAL_EMAIL_TYPES.has(type)) return { ok: true };
  const q = await tryConsumeQuota(workspaceId, 'email', DEFAULT_EMAIL_CAP_PER_DAY);
  if (!q.ok) {
    // eslint-disable-next-line no-console
    console.warn(`[email] workspace ${workspaceId} hit daily cap (${q.count}/${q.cap})`);
  }
  return q;
}

async function workspaceForUser(userId) {
  if (!userId) return null;
  try {
    const { rows } = await sql`
      SELECT id FROM workspaces WHERE owner_id = ${userId} LIMIT 1
    `;
    return rows[0]?.id || null;
  } catch { return null; }
}

async function workspaceForClient(clientId) {
  if (!clientId) return null;
  try {
    const { rows } = await sql`
      SELECT workspace_id FROM clients WHERE id = ${clientId} LIMIT 1
    `;
    return rows[0]?.workspace_id || null;
  } catch { return null; }
}

// Send a categorized email to a workspace owner (lookup by userId).
export async function sendEmailToUser({ userId, type, to, subject, html, text, replyTo, headers, timeoutMs }) {
  if (type && !(await userAllowsEmail(userId, type))) {
    return { ok: true, sent: false, reason: 'muted' };
  }
  const workspaceId = await workspaceForUser(userId);
  const q = await gateByQuota(workspaceId, type);
  if (!q.ok) return { ok: true, sent: false, reason: 'workspace-quota-exceeded' };
  // Mint a one-click unsubscribe URL for this owner + category. Critical
  // types (verification, password reset, etc.) skip — those have no
  // opt-out by design. Without a known userId we also skip; the generic
  // fallback in sendEmail still attaches a header pointing to the prefs
  // page so the email is never headerless.
  const unsubscribeUrl = (userId && type && !CRITICAL_EMAIL_TYPES.has(type))
    ? unsubscribeUrlFor({ scope: 'user', id: userId, type })
    : null;
  try {
    const result = await sendEmail({ to, subject, html, text, replyTo, headers, timeoutMs, unsubscribeUrl });
    return { ok: true, sent: true, result };
  } catch (err) {
    // Log loudly even though we don't throw - callers commonly wrap us
    // in try/catch expecting a throw on failure (Resend rate-limit, 422,
    // timeout). Without this line, a Resend outage silently swallows
    // every transactional email and operators only find out via user
    // complaints. Caller can still inspect { ok: false } if they care.
    // eslint-disable-next-line no-console
    console.error('[email/sendEmailToUser] send failed:', err.message, '(to', to, 'subject', JSON.stringify(subject).slice(0, 80) + ')');
    return { ok: false, sent: false, reason: err.message };
  }
}

// Send a categorized email to a client (lookup by clients.id). The
// workspace scoping is baked into clients.id (clients are workspace-
// scoped), so prefs are naturally per-workspace.
export async function sendEmailToClient({ clientId, type, to, subject, html, text, replyTo, headers, attachments, timeoutMs }) {
  if (type && !(await clientAllowsEmail(clientId, type))) {
    return { ok: true, sent: false, reason: 'muted' };
  }
  const workspaceId = await workspaceForClient(clientId);
  const q = await gateByQuota(workspaceId, type);
  if (!q.ok) return { ok: true, sent: false, reason: 'workspace-quota-exceeded' };
  const unsubscribeUrl = (clientId && type && !CRITICAL_EMAIL_TYPES.has(type))
    ? unsubscribeUrlFor({ scope: 'client', id: clientId, type })
    : null;
  try {
    const result = await sendEmail({ to, subject, html, text, replyTo, headers, attachments, timeoutMs, unsubscribeUrl });
    return { ok: true, sent: true, result };
  } catch (err) {
    // Same rationale as sendEmailToUser above - log loud on failure so
    // a Resend outage doesn't silently lose every invoice receipt /
    // booking confirmation / etc.
    // eslint-disable-next-line no-console
    console.error('[email/sendEmailToClient] send failed:', err.message, '(to', to, 'subject', JSON.stringify(subject).slice(0, 80) + ')');
    return { ok: false, sent: false, reason: err.message };
  }
}

// Send a categorized email to a (workspace, email) pair when the
// caller doesn't have a clients.id handy (e.g. public booking flow).
// Looks up the client by email + workspace; if none exists, sends.
export async function sendEmailToClientByAddress({ workspaceId, email, type, subject, html, text, replyTo, headers, timeoutMs }) {
  if (type && !(await clientAllowsEmailByAddress({ email, workspaceId, type }))) {
    return { ok: true, sent: false, reason: 'muted' };
  }
  const q = await gateByQuota(workspaceId, type);
  if (!q.ok) return { ok: true, sent: false, reason: 'workspace-quota-exceeded' };
  // Token is keyed on (workspaceId, email) — the public endpoint then
  // updates every clients row in this workspace matching that address,
  // so the opt-out sticks whether or not a clients record exists today.
  const unsubscribeUrl = (workspaceId && email && type && !CRITICAL_EMAIL_TYPES.has(type))
    ? unsubscribeUrlFor({ scope: 'clientEmail', id: email, workspaceId, type })
    : null;
  try {
    const result = await sendEmail({ to: email, subject, html, text, replyTo, headers, timeoutMs, unsubscribeUrl });
    return { ok: true, sent: true, result };
  } catch (err) {
    return { ok: false, sent: false, reason: err.message };
  }
}
