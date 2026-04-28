// Resend wrapper. Sends transactional email (verification, password reset).
// Env: RESEND_API_KEY (required), EMAIL_FROM (optional, defaults to onboarding@resend.dev).
//
// To send from your own domain instead of resend.dev, verify a domain in Resend
// and set EMAIL_FROM to e.g. "THRYVE <noreply@your-domain.com>".

const RESEND_URL = 'https://api.resend.com/emails';

function fromAddress() {
  return process.env.EMAIL_FROM || 'THRYVE <onboarding@resend.dev>';
}

export async function sendEmail({ to, subject, html, text }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY not set');

  const res = await fetch(RESEND_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: fromAddress(),
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
      text: text || stripHtml(html),
    }),
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
