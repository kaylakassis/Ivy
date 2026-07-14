// Welcome email content. Sent immediately at signup (api/auth/signup.js)
// and re-sendable from the admin user-detail modal
// (api/admin/users/[id].js → resendWelcome: true).
//
// Owner vs client variant is selected by the caller - owners get the
// "build your business" pitch, clients get the "consolidate every
// service provider" pitch. Both share a compliance footer with
// privacy/terms links, postal address, and verification-email nudge.

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Shared compliance + housekeeping footer. Slots in identically across
// both variants so any edits stay consistent.
//
//   • Verification-email reminder - every signup gets a separate
//     "confirm your email" message in addition to the welcome; mention
//     it here so people don't miss it in spam.
//   • Reply-to invitation
//   • Privacy / Terms links
//   • Postal address (placeholder until configured - CAN-SPAM /
//     CASL want a real one)
//   • Copyright
function renderFooter(appUrl) {
  const year = new Date().getUTCFullYear();
  return `
                    <p style="margin:0;padding:0;font-size:1em;padding-top:0.5em;padding-bottom:0.5em"><br /></p>
                    <hr style="width:100%;border:none;border-color:transparent;border-top:1px solid #2a2a2a;padding-bottom:1em;border-style:solid;border-width:2px" />
                    <p style="margin:0;padding:0;font-size:12px;color:#9ca3af;line-height:1.55">
                      <strong style="color:#F3F3EE;font-weight:600">Heads-up:</strong> we also sent you a separate email asking you to confirm your address. If you don't see it, check spam - confirming unlocks notifications.
                    </p>
                    <p style="margin:0;padding:0;font-size:12px;color:#9ca3af;line-height:1.55;margin-top:10px">
                      Reply to this email any time - we read everything.
                    </p>
                    <p style="margin:0;padding:0;font-size:12px;color:#9ca3af;line-height:1.55;margin-top:14px">
                      <a href="${appUrl}/privacy" style="color:#9ca3af;text-decoration:underline" target="_blank">Privacy</a>
                      &nbsp;&middot;&nbsp;
                      <a href="${appUrl}/terms" style="color:#9ca3af;text-decoration:underline" target="_blank">Terms</a>
                      &nbsp;&middot;&nbsp;
                      <a href="${appUrl}/account?tab=notifications" style="color:#9ca3af;text-decoration:underline" target="_blank">Email preferences</a>
                    </p>
                    <p style="margin:0;padding:0;font-size:12px;color:#9ca3af;line-height:1.55;margin-top:10px">
                      ${process.env.IVY_POSTAL_ADDRESS || 'Ivy · 1209 Orange St, Wilmington, DE 19801, USA'}
                    </p>
                    <p style="margin:0;padding:0;font-size:12px;color:#9ca3af;line-height:1.55;margin-top:6px">
                      © ${year} Ivy. All rights reserved.
                    </p>
                    <p style="margin:0;padding:0;font-size:1em;padding-top:0.5em;padding-bottom:0.5em"><br /></p>`;
}

export function renderWelcome({ name, appUrl, variant }) {
  if (variant === 'client') {
    return {
      subject: name ? `Welcome to Ivy, ${name}` : 'Welcome to Ivy',
      html: renderClientWelcome({ name, appUrl }),
    };
  }
  return {
    subject: name ? `Welcome to Ivy, ${name}` : 'Welcome to Ivy',
    html: renderOwnerWelcome({ name, appUrl }),
  };
}

// Owner welcome - dark Ivy-branded onboarding template (designed in
// Resend, exported as raw HTML). Returned as a complete document; no
// emailShell wrapper. Adds the trial / pricing line and the shared
// compliance footer.
//
// Variables resolved server-side:
//   {{{first_name}}}    → escapeHtml(name) with empty-string fallback
//   https://joinivy.ai → ${appUrl}/<route> so dev/preview deploys
//                          point at themselves
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
    <meta name="color-scheme" content="dark only" />
    <meta name="supported-color-schemes" content="dark only" />
  </head>
  <body style="background-color:#0D0E0C">
    <div style="display:none;overflow:hidden;line-height:1px;opacity:0;max-height:0;max-width:0" data-skip-in-text="true">
      Welcome to Ivy!
    </div>
    <table border="0" width="100%" cellpadding="0" cellspacing="0" role="presentation" align="center">
      <tbody>
        <tr>
          <td style="font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif;font-size:1em;min-height:100%;line-height:155%;background-color:#0D0E0C;color:#F3F3EE">
            <table align="left" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="max-width:600px;align:left;width:100%;color:#000000;background-color:#0D0E0C;padding:0;border-radius:0;border-color:#000000;line-height:155%">
              <tbody>
                <tr style="width:100%">
                  <td>
                    <p style="margin:0;padding:0;font-size:1em;padding-top:0.5em;padding-bottom:0.5em"><br /></p>
                    <h3 style="margin:0;padding:0;font-size:1.4em;line-height:1.08em;padding-top:0.389em;font-weight:600">
                      <span style="color:#CFFF50">Ivy</span>
                    </h3>
                    <h1 style="margin:0;padding:0;font-size:2.25em;line-height:1.44em;padding-top:0.389em;font-weight:600">
                      <span style="color:#F3F3EE">Welcome to Ivy${greetSuffix}.</span>
                    </h1>
                    <p style="margin:0;padding:0;font-size:16px;padding-top:0.5em;padding-bottom:0.5em;color:#F3F3EE;margin-top:0;margin-bottom:24px">
                      You just joined the ultimate AI-driven platform built for ambitious solo-preneurs. We're excited to help you grow faster, consolidate your back and front ends into one platform, and focus on what actually moves the needle.
                    </p>
                    <p style="margin:0;padding:0;font-size:16px;padding-top:0.5em;padding-bottom:0.5em;color:#F3F3EE;margin-top:0;margin-bottom:40px">
                      Here's the wild part: everything you used to juggle across five or more tools now lives in one place. And it gets sharper the more you use it.
                    </p>
                    <table align="center" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">
                      <tbody style="width:100%">
                        <tr style="width:100%">
                          <td align="left">
                            <a href="${appUrl}/dashboard" style="line-height:100%;text-decoration:none;display:inline-block;max-width:100%;mso-padding-alt:0px;margin:0;padding:12px 50px;background-color:#CFFF50;color:#000000;border-radius:4px;font-weight:500;font-size:15px;text-align:center;margin-bottom:48px" target="_blank">
                              <span style="max-width:100%;display:inline-block;line-height:120%;mso-padding-alt:0px;mso-text-raise:9px">Launch your dashboard →</span>
                            </a>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                    <hr style="width:100%;border:none;border-color:transparent;border-top:1px solid #e8e8e4;padding-bottom:1em;border-style:solid;border-width:2px;margin-top:0;margin-bottom:40px" />
                    <h2 style="margin:0;padding:0;font-size:35px;line-height:1.44em;font-weight:600;letter-spacing:-0.5px;margin-top:0;margin-bottom:24px">
                      <span style="color:#F3F3EE">What you can do today</span>
                    </h2>
                    <p style="margin:0;padding:0;font-size:16px;padding-top:0.5em;padding-bottom:0.5em;font-weight:600;color:#F3F3EE;margin-top:0;margin-bottom:6px">
                      01 Build your front end in minutes
                    </p>
                    <p style="margin:0;padding:0;font-size:15px;padding-top:0.5em;padding-bottom:0.5em;color:#F3F3EE;margin-top:0;margin-bottom:24px">
                      Spin up a landing page, storefront, or booking flow without touching code. Your AI assistant handles the heavy lifting.
                    </p>
                    <p style="margin:0;padding:0;font-size:16px;padding-top:0.5em;padding-bottom:0.5em;font-weight:600;color:#F3F3EE;margin-top:0;margin-bottom:6px">
                      02 Automate the back end
                    </p>
                    <p style="margin:0;padding:0;font-size:15px;padding-top:0.5em;padding-bottom:0.5em;color:#F3F3EE;margin-top:0;margin-bottom:24px">
                      Payments, CRM, invoicing, analytics - connected on day one.
                    </p>
                    <p style="margin:0;padding:0;font-size:16px;padding-top:0.5em;padding-bottom:0.5em;font-weight:600;color:#F3F3EE;margin-top:0;margin-bottom:6px">
                      03 Let AI run the busywork
                    </p>
                    <p style="margin:0;padding:0;font-size:15px;padding-top:0.5em;padding-bottom:0.5em;color:#F3F3EE;margin-top:0;margin-bottom:40px">
                      Ivy, your AI assistant, can draft messages, send invoices, follow up with leads, and surface what needs your attention - so you stay focused on the work only you can do.
                    </p>
                    <hr style="width:100%;border:none;border-color:transparent;border-top:1px solid #e8e8e4;padding-bottom:1em;border-style:solid;border-width:2px;margin-top:0;margin-bottom:40px" />
                    <h2 style="margin:0;padding:0;font-size:35px;line-height:1.44em;font-weight:600;letter-spacing:-0.5px;margin-top:0;margin-bottom:16px">
                      <span style="color:#F3F3EE">Start with a 60-second win</span>
                    </h2>
                    <p style="margin:0;padding:0;font-size:16px;padding-top:0.5em;padding-bottom:0.5em;color:#F3F3EE;margin-top:0;margin-bottom:32px">
                      Most founders feel the magic on their very first task. Pick one and let Ivy show you what it can do.
                    </p>
                    <p style="margin:0;padding:0;font-size:15px;padding-top:0.5em;padding-bottom:0.5em;color:#F3F3EE;margin-top:0;margin-bottom:12px">
                      → <a href="${appUrl}/onboarding" rel="noopener noreferrer nofollow" style="color:#F3F3EE;text-decoration:underline" target="_blank">Set up your booking link</a>
                    </p>
                    <p style="margin:0;padding:0;font-size:15px;padding-top:0.5em;padding-bottom:0.5em;color:#F3F3EE;margin-top:0;margin-bottom:12px">
                      → <a href="${appUrl}/clients" rel="noopener noreferrer nofollow" style="color:#F3F3EE;text-decoration:underline" target="_blank">Add your clients</a>
                    </p>
                    <p style="margin:0;padding:0;font-size:15px;padding-top:0.5em;padding-bottom:0.5em;color:#F3F3EE;margin-top:0;margin-bottom:12px">
                      → <a href="${appUrl}/website" rel="noopener noreferrer nofollow" style="color:#F3F3EE;text-decoration:underline" target="_blank">Generate your first landing page</a>
                    </p>
                    <p style="margin:0;padding:0;font-size:15px;padding-top:0.5em;padding-bottom:0.5em;color:#F3F3EE;margin-top:0;margin-bottom:40px">
                      → <a href="${appUrl}/ivy" rel="noopener noreferrer nofollow" style="color:#F3F3EE;text-decoration:underline" target="_blank">Meet your AI assistant</a>
                    </p>
                    <h2 style="margin:0;padding:0;font-size:35px;line-height:1.44em;padding-top:0.389em;font-weight:600;letter-spacing:-0.4px;margin-top:0;margin-bottom:12px;text-align:center">
                      <span style="color:#F3F3EE">This is just the beginning.</span>
                    </h2>
                    <table align="center" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">
                      <tbody style="width:100%">
                        <tr style="width:100%">
                          <td align="center">
                            <a href="${appUrl}/dashboard" style="line-height:100%;text-decoration:none;display:inline-block;max-width:100%;mso-padding-alt:0px;margin:0;padding:12px 50px;background-color:#CFFF50;color:#000000;border-radius:4px;font-weight:500;font-size:15px;text-align:center;margin-bottom:8px" target="_blank">
                              <span style="max-width:100%;display:inline-block;line-height:120%;mso-padding-alt:0px;mso-text-raise:9px">Open Ivy</span>
                            </a>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                    <p style="margin:0;padding:0;font-size:14px;padding-top:0.5em;padding-bottom:0.5em;color:#F3F3EE;margin-top:32px;margin-bottom:4px">
                      Welcome to the future of business OS,
                    </p>
                    <p style="margin:0;padding:0;font-size:14px;padding-top:0.5em;padding-bottom:0.5em;color:#F3F3EE;font-weight:600;margin-top:0;margin-bottom:24px">
                      Kayla Kassis, Founder of Ivy.
                    </p>
                    <p style="margin:0;padding:0;font-size:13px;color:#9ca3af;line-height:1.55;font-style:italic;margin-top:8px">
                      Finish setup, then start your 14-day free trial. We'll ask for a card so nothing pauses if you forget - $0 today, $8.99 every week after, cancel anytime before then.
                    </p>
                    ${renderFooter(appUrl)}
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

// Client welcome - same dark aesthetic as the owner template, value
// prop reversed: instead of "build your business," it's "consolidate
// every business you book with into one inbox / wallet / calendar."
function renderClientWelcome({ name, appUrl }) {
  const greetSuffix = name ? `, ${escapeHtml(name)}` : '';
  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html dir="ltr" lang="en">
  <head>
    <meta content="width=device-width" name="viewport" />
    <meta content="text/html; charset=UTF-8" http-equiv="Content-Type" />
    <meta name="x-apple-disable-message-reformatting" />
    <meta content="IE=edge" http-equiv="X-UA-Compatible" />
    <meta content="telephone=no,address=no,email=no,date=no,url=no" name="format-detection" />
    <meta name="color-scheme" content="dark only" />
    <meta name="supported-color-schemes" content="dark only" />
  </head>
  <body style="background-color:#0D0E0C">
    <div style="display:none;overflow:hidden;line-height:1px;opacity:0;max-height:0;max-width:0" data-skip-in-text="true">
      Every service provider you use, in one place.
    </div>
    <table border="0" width="100%" cellpadding="0" cellspacing="0" role="presentation" align="center">
      <tbody>
        <tr>
          <td style="font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif;font-size:1em;min-height:100%;line-height:155%;background-color:#0D0E0C;color:#F3F3EE">
            <table align="left" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="max-width:600px;align:left;width:100%;color:#000000;background-color:#0D0E0C;padding:0;border-radius:0;border-color:#000000;line-height:155%">
              <tbody>
                <tr style="width:100%">
                  <td>
                    <p style="margin:0;padding:0;font-size:1em;padding-top:0.5em;padding-bottom:0.5em"><br /></p>
                    <h3 style="margin:0;padding:0;font-size:1.4em;line-height:1.08em;padding-top:0.389em;font-weight:600">
                      <span style="color:#CFFF50">Ivy</span>
                    </h3>
                    <h1 style="margin:0;padding:0;font-size:2.25em;line-height:1.44em;padding-top:0.389em;font-weight:600">
                      <span style="color:#F3F3EE">Welcome to Ivy${greetSuffix}.</span>
                    </h1>
                    <p style="margin:0;padding:0;font-size:16px;padding-top:0.5em;padding-bottom:0.5em;color:#F3F3EE;margin-top:0;margin-bottom:24px">
                      Every service provider you book with - your stylist, your trainer, your therapist, your contractor, your tutor - now lives in one place. Bills, bookings, memberships, messages. No more hunting through ten different texts and inboxes.
                    </p>
                    <p style="margin:0;padding:0;font-size:16px;padding-top:0.5em;padding-bottom:0.5em;color:#F3F3EE;margin-top:0;margin-bottom:40px">
                      Your portal's ready. Tap in and you'll feel the difference immediately.
                    </p>
                    <table align="center" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">
                      <tbody style="width:100%">
                        <tr style="width:100%">
                          <td align="left">
                            <a href="${appUrl}/me" style="line-height:100%;text-decoration:none;display:inline-block;max-width:100%;mso-padding-alt:0px;margin:0;padding:12px 50px;background-color:#CFFF50;color:#000000;border-radius:4px;font-weight:500;font-size:15px;text-align:center;margin-bottom:48px" target="_blank">
                              <span style="max-width:100%;display:inline-block;line-height:120%;mso-padding-alt:0px;mso-text-raise:9px">Open my dashboard →</span>
                            </a>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                    <hr style="width:100%;border:none;border-color:transparent;border-top:1px solid #e8e8e4;padding-bottom:1em;border-style:solid;border-width:2px;margin-top:0;margin-bottom:40px" />
                    <h2 style="margin:0;padding:0;font-size:35px;line-height:1.44em;font-weight:600;letter-spacing:-0.5px;margin-top:0;margin-bottom:24px">
                      <span style="color:#F3F3EE">What's waiting for you</span>
                    </h2>
                    <p style="margin:0;padding:0;font-size:16px;padding-top:0.5em;padding-bottom:0.5em;font-weight:600;color:#F3F3EE;margin-top:0;margin-bottom:6px">
                      01 Pay every bill in one place
                    </p>
                    <p style="margin:0;padding:0;font-size:15px;padding-top:0.5em;padding-bottom:0.5em;color:#F3F3EE;margin-top:0;margin-bottom:24px">
                      Every invoice from every provider, lined up. Tap to pay with the card already on file. No more chasing emails or guessing what you owe.
                    </p>
                    <p style="margin:0;padding:0;font-size:16px;padding-top:0.5em;padding-bottom:0.5em;font-weight:600;color:#F3F3EE;margin-top:0;margin-bottom:6px">
                      02 Stay ahead of every renewal
                    </p>
                    <p style="margin:0;padding:0;font-size:15px;padding-top:0.5em;padding-bottom:0.5em;color:#F3F3EE;margin-top:0;margin-bottom:24px">
                      Memberships and recurring services in one view. Cancel, pause, or upgrade with one tap - and never get auto-charged for something you forgot about.
                    </p>
                    <p style="margin:0;padding:0;font-size:16px;padding-top:0.5em;padding-bottom:0.5em;font-weight:600;color:#F3F3EE;margin-top:0;margin-bottom:6px">
                      03 Message your providers directly
                    </p>
                    <p style="margin:0;padding:0;font-size:15px;padding-top:0.5em;padding-bottom:0.5em;color:#F3F3EE;margin-top:0;margin-bottom:24px">
                      Every reply lands in your Ivy inbox - not buried in your texts. Voice memos, photos, signed documents, all in one thread.
                    </p>
                    <p style="margin:0;padding:0;font-size:16px;padding-top:0.5em;padding-bottom:0.5em;font-weight:600;color:#F3F3EE;margin-top:0;margin-bottom:6px">
                      04 Find new providers near you
                    </p>
                    <p style="margin:0;padding:0;font-size:15px;padding-top:0.5em;padding-bottom:0.5em;color:#F3F3EE;margin-top:0;margin-bottom:40px">
                      Browse the Discover tab - filter by category, price, distance, or rating - and book in two taps. The whole experience, from finding to paying, never leaves Ivy.
                    </p>
                    <hr style="width:100%;border:none;border-color:transparent;border-top:1px solid #e8e8e4;padding-bottom:1em;border-style:solid;border-width:2px;margin-top:0;margin-bottom:40px" />
                    <h2 style="margin:0;padding:0;font-size:35px;line-height:1.44em;padding-top:0.389em;font-weight:600;letter-spacing:-0.4px;margin-top:0;margin-bottom:12px;text-align:center">
                      <span style="color:#F3F3EE">Your life just got simpler.</span>
                    </h2>
                    <table align="center" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">
                      <tbody style="width:100%">
                        <tr style="width:100%">
                          <td align="center">
                            <a href="${appUrl}/me" style="line-height:100%;text-decoration:none;display:inline-block;max-width:100%;mso-padding-alt:0px;margin:0;padding:12px 50px;background-color:#CFFF50;color:#000000;border-radius:4px;font-weight:500;font-size:15px;text-align:center;margin-bottom:8px" target="_blank">
                              <span style="max-width:100%;display:inline-block;line-height:120%;mso-padding-alt:0px;mso-text-raise:9px">Open Ivy</span>
                            </a>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                    <p style="margin:0;padding:0;font-size:14px;padding-top:0.5em;padding-bottom:0.5em;color:#F3F3EE;margin-top:32px;margin-bottom:4px">
                      Glad you're here,
                    </p>
                    <p style="margin:0;padding:0;font-size:14px;padding-top:0.5em;padding-bottom:0.5em;color:#F3F3EE;font-weight:600;margin-top:0;margin-bottom:0">
                      Kayla Kassis, Founder of Ivy.
                    </p>
                    ${renderFooter(appUrl)}
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
