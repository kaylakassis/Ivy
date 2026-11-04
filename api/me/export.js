// /api/me/export - "Download my data" for the client portal.
//   GET  - the file as a download (web).
//   POST - the same file emailed to the account's address (works inside
//          the iPhone app, where a web view cannot save a download).
//
// A JSON file of what the signed-in person's businesses hold about them as
// a client (bookings, invoices, documents, messages, packages,
// memberships, reviews), built by api/_lib/clientExport.js from explicit
// column lists, so business-private fields never appear in it.
//
// Unlike /api/account/export this never creates a workspace, so a client
// who downloads their data does not quietly become a business owner.
import { requireUser } from '../_lib/auth.js';
import { requireSameOrigin } from '../_lib/security.js';
import { enforce, getClientIp } from '../_lib/rate-limit.js';
import { buildClientPortalExport } from '../_lib/clientExport.js';
import { sendEmail, emailShell } from '../_lib/email.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

const MAX_EMAIL_ATTACH_BYTES = 18 * 1024 * 1024;

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function buildPayload(user) {
  const data = await buildClientPortalExport(user);
  return {
    ivy_client_export_version: 1,
    exported_at: new Date().toISOString(),
    account: { name: user.name || null, email: user.email || null },
    ...data,
  };
}

const filename = () => `ivy-my-data-${new Date().toISOString().slice(0, 10)}.json`;

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    if (req.method === 'GET') {
      if (await enforce(req, res, [{ key: `me-export:${user.id}`, max: 10, windowSeconds: 60 * 60 }])) return;
      const payload = await buildPayload(user);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename()}"`);
      res.setHeader('Cache-Control', 'no-store');
      res.status(200);
      return res.end(JSON.stringify(payload, null, 2));
    }

    if (!user.email) return badRequest(res, 'Your account has no email on file.');
    if (await enforce(req, res, [
      { key: `me-export-email:user:${user.id}`, max: 3, windowSeconds: 60 * 60 },
      { key: `me-export-email:ip:${getClientIp(req)}`, max: 6, windowSeconds: 60 * 60 },
    ])) return;
    const json = JSON.stringify(await buildPayload(user), null, 2);
    const bytes = Buffer.byteLength(json, 'utf8');
    const tooBig = bytes > MAX_EMAIL_ATTACH_BYTES;
    const fn = escapeHtml((user.name || '').split(/\s+/)[0] || 'there');
    const name = filename();
    await sendEmail({
      to: user.email,
      subject: 'Your Ivy data is ready',
      html: emailShell({
        heading: 'Your data is ready',
        preheader: tooBig ? 'How to download it inside.' : 'Your file is attached.',
        body: tooBig
          ? `<p>Hi ${fn},</p><p>Your file is too large to attach to an email. Sign in to Ivy on the web and open Profile, then Privacy, then Download my data.</p>`
          : `<p>Hi ${fn},</p><p>Here is a copy of what the businesses you book with on Ivy hold about you, attached as <strong>${escapeHtml(name)}</strong>.</p><p>Keep it somewhere safe. If you did not ask for this, reply to this email.</p>`,
        footer: 'The Ivy Team',
      }),
      timeoutMs: 20000,
      attachments: tooBig ? undefined : [{
        filename: name,
        content: Buffer.from(json, 'utf8').toString('base64'),
        contentType: 'application/json',
      }],
    });
    return ok(res, { emailed: true, attached: !tooBig });
  } catch (err) {
    return serverError(res, err);
  }
}
