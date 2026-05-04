// Resend wrapper. Sends transactional email (verification, password reset).
// Env:
//   RESEND_API_KEY (required)
//   EMAIL_FROM     (defaults to onboarding@resend.dev — replace once you've
//                   verified your own domain in Resend)
//   EMAIL_REPLY_TO (optional — where replies should route; defaults to
//                   stripping the From-name so user replies hit it)
//
// To send from your own domain instead of resend.dev:
//   1. Add your domain in https://resend.com/domains and complete the DNS
//      records they list (SPF, DKIM, DMARC). Status must read "Verified".
//   2. Set EMAIL_FROM='THRYVE <noreply@your-domain.com>' in Vercel envs.
//   3. Set EMAIL_REPLY_TO='support@your-domain.com' so user replies have
//      somewhere to land.
//   4. Hit GET /api/admin/email-status with your ADMIN_SECRET to confirm
//      Resend reports the domain as verified.

const RESEND_URL = 'https://api.resend.com/emails';

function fromAddress() {
  return process.env.EMAIL_FROM || 'THRYVE <onboarding@resend.dev>';
}

function replyToAddress() {
  return process.env.EMAIL_REPLY_TO || null;
}

function isProd() {
  return process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production';
}

function fromDomain() {
  // Pull "user@domain.tld" out of either bare or "Name <addr>" form.
  const raw = fromAddress();
  const m = raw.match(/<([^>]+)>/) || [null, raw];
  return (m[1] || '').split('@').pop()?.toLowerCase().trim();
}

// Hard guard against the easiest deliverability footgun: deploying to
// production with `onboarding@resend.dev` as the sender. Gmail filters
// it aggressively into spam, so password-reset / verification emails
// never reach the user. Refusing to send up-front is much louder than
// "delivered to spam, no idea why".
function assertSafeProdFrom() {
  if (!isProd()) return;
  const dom = fromDomain();
  if (!process.env.EMAIL_FROM) {
    throw new Error(
      'EMAIL_FROM is not set. Add a verified Resend domain in production env (e.g. \'THRYVE <noreply@thryve.app>\').',
    );
  }
  if (dom === 'resend.dev' || dom === 'example.com' || !dom) {
    throw new Error(
      `EMAIL_FROM domain "${dom}" is not deliverable in production. Verify your own domain in Resend (Domains → Add) and set EMAIL_FROM to use it.`,
    );
  }
}

export async function sendEmail({ to, subject, html, text, replyTo, headers }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY not set');

  assertSafeProdFrom();

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
    throw new Error(`Resend ${res.status}: ${detail.slice(0, 200)}`);
  }
  return res.json();
}

function stripHtml(s = '') {
  return s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

// Branded-but-minimal email shell. Looks decent, won't break in any client.
export function emailShell({ heading, body, ctaText, ctaUrl, footer }) {
  const cta = ctaText && ctaUrl
    ? `<p style="margin:32px 0;text-align:center;">
         <a href="${ctaUrl}" style="display:inline-block;padding:13px 24px;background:#2E3168;color:#FFFFFF;
            text-decoration:none;border-radius:10px;font-weight:550;font-size:14px;">
           ${ctaText}
         </a>
       </p>
       <p style="font-size:12px;color:#85827B;word-break:break-all;">
         Or paste this link into your browser: <br/>${ctaUrl}
       </p>`
    : '';

  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#F6F5F1;font-family:-apple-system,system-ui,'Inter',sans-serif;color:#141414;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr><td align="center">
      <table role="presentation" width="520" cellpadding="0" cellspacing="0"
             style="background:#FFFFFF;border:1px solid #E8E4DC;border-radius:14px;overflow:hidden;">
        <tr><td style="padding:32px 32px 8px;">
          <div style="font-family:'Fraunces',Georgia,serif;font-size:22px;letter-spacing:-0.02em;font-weight:500;">thryve</div>
        </td></tr>
        <tr><td style="padding:8px 32px 32px;">
          <h1 style="margin:0 0 16px;font-family:'Fraunces',Georgia,serif;font-size:24px;letter-spacing:-0.025em;font-weight:500;line-height:1.2;">${heading}</h1>
          <div style="font-size:15px;line-height:1.6;color:#3F3D38;">${body}</div>
          ${cta}
          ${footer ? `<hr style="border:0;border-top:1px solid #E8E4DC;margin:32px 0 16px;"/>
                     <div style="font-size:12px;color:#85827B;line-height:1.55;">${footer}</div>` : ''}
        </td></tr>
      </table>
      <div style="font-size:11px;color:#A9A59B;margin-top:14px;">Sent by THRYVE Business OS</div>
    </td></tr>
  </table>
</body></html>`;
}
