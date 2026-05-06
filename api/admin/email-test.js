// POST /api/admin/email-test  { "to": "..." }
// Sends a test email through the same code path the rest of the app uses,
// so you can confirm From / Reply-To / DNS auth all work end-to-end.
//
//   curl -X POST https://getthryve.ai/api/admin/email-test \
//     -H "x-admin-secret: $ADMIN_SECRET" \
//     -H "Content-Type: application/json" \
//     -d '{"to":"you@example.com"}'
//
// Then open the message and check the headers — you should see
// `Authentication-Results: ... spf=pass dkim=pass dmarc=pass`.
import { sendEmail, emailShell } from '../_lib/email.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { requireSuperAdmin } from '../_lib/admin.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  if (!(await requireSuperAdmin(req, res))) return;

  try {
    const body = await readBody(req);
    const to = (body.to || '').toString().trim();
    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      return badRequest(res, 'Provide a valid `to` email address');
    }

    const html = emailShell({
      heading: 'Test email from THRYVE',
      body: `<p>If you're reading this in an inbox (not spam), your sending
        domain is configured correctly.</p>
        <p>Open the email's source / "show original" and confirm the
        Authentication-Results header reads:<br/>
        <code>spf=pass dkim=pass dmarc=pass</code></p>
        <p>If any of those say <code>fail</code> or <code>none</code>, fix
        the corresponding DNS record at your domain registrar — Resend's
        dashboard shows the exact values.</p>`,
      footer: `Sent from /api/admin/email-test at ${new Date().toISOString()}`,
    });

    const result = await sendEmail({
      to,
      subject: 'THRYVE deliverability test',
      html,
    });
    return ok(res, { ok: true, id: result?.id || null });
  } catch (err) {
    return serverError(res, err);
  }
}
