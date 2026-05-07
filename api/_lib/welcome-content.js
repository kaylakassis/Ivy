// Welcome email content. Sent immediately at signup (api/auth/signup.js)
// and re-sendable from the admin user-detail modal
// (api/admin/users/[id].js → resendWelcome: true).
//
// Owner vs client variant is selected by the caller — owners get the
// dark THRYVE-branded onboarding template (designed in Resend, exported
// as raw HTML), client-only users get the "your portal" pitch built
// from the standard emailShell.
import { emailShell } from './email.js';

const WELCOME_FOOTER = `<p style="margin:0;font-size:11px;color:#85827B;line-height:1.5;">
  You're getting this because you just signed up for THRYVE.
  Reply to this email any time — we read everything.
</p>`;

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function renderWelcome({ name, appUrl, variant }) {
  if (variant === 'client') {
    return {
      subject: 'Welcome to THRYVE — your client portal',
      html: emailShell({
        heading: `Welcome${name ? `, ${name}` : ''} 👋`,
        body: `<p>You've got a free THRYVE account, and that's a good thing —
          it means every business you book with on THRYVE shows up in one
          place: appointments, invoices, forms to sign, direct messages.</p>
          <p><strong>One tap and you're in.</strong> Your portal lives at
          <code style="font-family:inherit;background:#F1EEE6;padding:2px 6px;border-radius:6px;">/me</code>.</p>
          <p>If you're new to THRYVE, browse the Discover tab to find
          businesses near you — filter by category, price, distance, or
          rating — and book in two taps.</p>`,
        ctaText: 'Open my portal',
        ctaUrl: `${appUrl}/me`,
        footer: WELCOME_FOOTER,
      }),
    };
  }
  return {
    subject: name ? `Welcome to THRYVE, ${name}` : 'Welcome to THRYVE',
    html: renderOwnerWelcome({ name, appUrl }),
  };
}

// Dark-themed onboarding template designed in Resend. Returned as a
// complete HTML document (own DOCTYPE + body) — sendEmail() ships it
// to Resend as-is, no shell wrapper.
//
// Variables:
//   {first_name} — handled here. When the user didn't enter a name we
//                  drop both the comma and the placeholder so the H1
//                  reads "Welcome to THRYVE." instead of "Welcome to
//                  THRYVE, ."
//   appUrl       — every CTA / link target is built relative to this
//                  so dev/preview deploys point at themselves and
//                  production points at https://getthryve.ai (set via
//                  APP_URL).
function renderOwnerWelcome({ name, appUrl }) {
  const greetSuffix = name ? `, ${escapeHtml(name)}` : '';
  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html dir="ltr" lang="en">
  <head>
    <meta content="width=device-width" name="viewport" />
    <meta content="text/html; charset=UTF-8" http-equiv="Content-Type" />
    <meta name="x-apple-disable-message-reformatting" />
    <meta content="IE=edge" http-equiv="X-UA-Compatible" />
    <meta content="telephone=no,address=no,email=no,date=no,url=no" name="format-detection" />
  </head>
  <body style="background-color:#000000">
    <div style="display:none;overflow:hidden;line-height:1px;opacity:0;max-height:0;max-width:0" data-skip-in-text="true">
      Welcome to THRYVE!
    </div>
    <table border="0" width="100%" cellpadding="0" cellspacing="0" role="presentation" align="center">
      <tbody>
        <tr>
          <td style="font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif;font-size:1em;min-height:100%;line-height:155%;background-color:#000000;color:#ffffff">
            <table align="left" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="max-width:600px;align:left;width:100%;color:#000000;background-color:#000000;padding:0;border-radius:0;border-color:#000000;line-height:155%">
              <tbody>
                <tr style="width:100%">
                  <td>
                    <p style="margin:0;padding:0;font-size:1em;padding-top:0.5em;padding-bottom:0.5em"><br /></p>
                    <h3 style="margin:0;padding:0;font-size:1.4em;line-height:1.08em;padding-top:0.389em;font-weight:600">
                      <span style="color:#cdff45">THRYVE</span>
                    </h3>
                    <h1 style="margin:0;padding:0;font-size:2.25em;line-height:1.44em;padding-top:0.389em;font-weight:600">
                      <span style="color:#ffffff">Welcome to THRYVE${greetSuffix}.</span>
                    </h1>
                    <p style="margin:0;padding:0;font-size:16px;padding-top:0.5em;padding-bottom:0.5em;color:#ffffff;margin-top:0;margin-bottom:24px">
                      You just joined the ultimate AI-driven platform built for ambitious solo-preneurs. We're excited to help you grow faster, consolidate your back and front ends into one platform, and focus on what actually moves the needle.
                    </p>
                    <p style="margin:0;padding:0;font-size:16px;padding-top:0.5em;padding-bottom:0.5em;color:#ffffff;margin-top:0;margin-bottom:40px">
                      Here's the wild part: everything you used to juggle across five or more tools now lives in one place. And it gets sharper the more you use it.
                    </p>
                    <table align="center" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">
                      <tbody style="width:100%">
                        <tr style="width:100%">
                          <td align="left">
                            <a href="${appUrl}/dashboard" style="line-height:100%;text-decoration:none;display:inline-block;max-width:100%;mso-padding-alt:0px;margin:0;padding:12px 50px;background-color:#cdff45;color:#000000;border-radius:4px;font-weight:500;font-size:15px;text-align:center;margin-bottom:48px" target="_blank">
                              <span style="max-width:100%;display:inline-block;line-height:120%;mso-padding-alt:0px;mso-text-raise:9px">Launch your dashboard →</span>
                            </a>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                    <hr style="width:100%;border:none;border-color:transparent;border-top:1px solid #e8e8e4;padding-bottom:1em;border-style:solid;border-width:2px;margin-top:0;margin-bottom:40px" />
                    <h2 style="margin:0;padding:0;font-size:35px;line-height:1.44em;font-weight:600;letter-spacing:-0.5px;margin-top:0;margin-bottom:24px">
                      <span style="color:#ffffff">What you can do today</span>
                    </h2>
                    <p style="margin:0;padding:0;font-size:16px;padding-top:0.5em;padding-bottom:0.5em;font-weight:600;color:#ffffff;margin-top:0;margin-bottom:6px">
                      01 Build your front end in minutes
                    </p>
                    <p style="margin:0;padding:0;font-size:15px;padding-top:0.5em;padding-bottom:0.5em;color:#ffffff;margin-top:0;margin-bottom:24px">
                      Spin up a landing page, storefront, or booking flow without touching code. Your AI assistant handles the heavy lifting.
                    </p>
                    <p style="margin:0;padding:0;font-size:16px;padding-top:0.5em;padding-bottom:0.5em;font-weight:600;color:#ffffff;margin-top:0;margin-bottom:6px">
                      02 Automate the back end
                    </p>
                    <p style="margin:0;padding:0;font-size:15px;padding-top:0.5em;padding-bottom:0.5em;color:#ffffff;margin-top:0;margin-bottom:24px">
                      Payments, CRM, invoicing, analytics — connected on day one.
                    </p>
                    <p style="margin:0;padding:0;font-size:16px;padding-top:0.5em;padding-bottom:0.5em;font-weight:600;color:#ffffff;margin-top:0;margin-bottom:6px">
                      03 Let AI run the busywork
                    </p>
                    <p style="margin:0;padding:0;font-size:15px;padding-top:0.5em;padding-bottom:0.5em;color:#ffffff;margin-top:0;margin-bottom:40px">
                      Ivy, your AI-assistant and coach, can draft messages, send invoices, follow up with leads, and surface what needs your attention — so you stay focused on the work only you can do.
                    </p>
                    <hr style="width:100%;border:none;border-color:transparent;border-top:1px solid #e8e8e4;padding-bottom:1em;border-style:solid;border-width:2px;margin-top:0;margin-bottom:40px" />
                    <h2 style="margin:0;padding:0;font-size:35px;line-height:1.44em;font-weight:600;letter-spacing:-0.5px;margin-top:0;margin-bottom:16px">
                      <span style="color:#ffffff">Start with a 60-second win</span>
                    </h2>
                    <p style="margin:0;padding:0;font-size:16px;padding-top:0.5em;padding-bottom:0.5em;color:#ffffff;margin-top:0;margin-bottom:32px">
                      Most founders feel the magic on their very first task. Pick one and let THRYVE show you what it can do.
                    </p>
                    <p style="margin:0;padding:0;font-size:15px;padding-top:0.5em;padding-bottom:0.5em;color:#ffffff;margin-top:0;margin-bottom:12px">
                      → <a href="${appUrl}/account" rel="noopener noreferrer nofollow" style="color:#ffffff;text-decoration:underline" target="_blank">Create your domain</a>
                    </p>
                    <p style="margin:0;padding:0;font-size:15px;padding-top:0.5em;padding-bottom:0.5em;color:#ffffff;margin-top:0;margin-bottom:12px">
                      → <a href="${appUrl}/clients" rel="noopener noreferrer nofollow" style="color:#ffffff;text-decoration:underline" target="_blank">Add your clients</a>
                    </p>
                    <p style="margin:0;padding:0;font-size:15px;padding-top:0.5em;padding-bottom:0.5em;color:#ffffff;margin-top:0;margin-bottom:12px">
                      → <a href="${appUrl}/website" rel="noopener noreferrer nofollow" style="color:#ffffff;text-decoration:underline" target="_blank">Generate your first landing page</a>
                    </p>
                    <p style="margin:0;padding:0;font-size:15px;padding-top:0.5em;padding-bottom:0.5em;color:#ffffff;margin-top:0;margin-bottom:40px">
                      → <a href="${appUrl}/ivy" rel="noopener noreferrer nofollow" style="color:#ffffff;text-decoration:underline" target="_blank">Meet your AI assistant</a>
                    </p>
                    <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="padding:28px;box-sizing:border-box;background-color:#f5f5f3;border-radius:12px;margin-bottom:40px">
                      <tbody>
                        <tr>
                          <td>
                            <p style="margin:0;padding:0;font-size:15px;padding-top:0.5em;padding-bottom:0.5em;color:#1a1a1a;font-style:italic;margin-top:0;margin-bottom:12px">
                              "I replaced six subscriptions with THRYVE in a single weekend, for a fraction of the cost. My business has never moved faster."
                            </p>
                            <p style="margin:0;padding:0;font-size:1em;padding-top:0.5em;padding-bottom:0.5em;color:#1a1a1a">
                              <em>— THRYVE User</em>
                            </p>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                    <h2 style="margin:0;padding:0;font-size:35px;line-height:1.44em;padding-top:0.389em;font-weight:600;letter-spacing:-0.4px;margin-top:0;margin-bottom:12px;text-align:center">
                      <span style="color:#ffffff">This is just the beginning.</span>
                    </h2>
                    <table align="center" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">
                      <tbody style="width:100%">
                        <tr style="width:100%">
                          <td align="center">
                            <a href="${appUrl}/dashboard" style="line-height:100%;text-decoration:none;display:inline-block;max-width:100%;mso-padding-alt:0px;margin:0;padding:12px 50px;background-color:#cdff45;color:#000000;border-radius:4px;font-weight:500;font-size:15px;text-align:center;margin-bottom:8px" target="_blank">
                              <span style="max-width:100%;display:inline-block;line-height:120%;mso-padding-alt:0px;mso-text-raise:9px">Open THRYVE</span>
                            </a>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                    <p style="margin:0;padding:0;font-size:14px;padding-top:0.5em;padding-bottom:0.5em;color:#ffffff;margin-top:32px;margin-bottom:4px">
                      Welcome to the future of business OS,
                    </p>
                    <p style="margin:0;padding:0;font-size:14px;padding-top:0.5em;padding-bottom:0.5em;color:#ffffff;font-weight:600;margin-top:0;margin-bottom:0">
                      Kayla Kassis, Founder of THRYVE.
                    </p>
                    <p style="margin:0;padding:0;font-size:1em;padding-top:0.5em;padding-bottom:0.5em"><br /></p>
                    <hr style="width:100%;border:none;border-color:transparent;border-top:1px solid #eaeaea;padding-bottom:1em;border-style:solid;border-width:2px" />
                    <p style="margin:0;padding:0;font-size:11px;color:#737373;line-height:1.5">
                      You're getting this because you just signed up for THRYVE. Reply to this email any time — we read everything.
                    </p>
                    <p style="margin:0;padding:0;font-size:1em;padding-top:0.5em;padding-bottom:0.5em"><br /></p>
                  </td>
                </tr>
              </tbody>
            </table>
          </td>
        </tr>
      </tbody>
    </table>
  </body>
</html>`;
}
