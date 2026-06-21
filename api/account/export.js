// /api/account/export
//   GET  - streams a JSON dump of every row tied to the authenticated
//          user's account (GDPR right-to-portability), as a file download.
//   POST - emails that same export to the user as a .json attachment, plus
//          a confirmation. Useful as a durable record, or when the user
//          wants a copy without a browser download.
//
// Both share api/_lib/accountExport.js so the two never drift.
import { requireUser } from '../_lib/auth.js';
import { buildAccountExport, exportFilename } from '../_lib/accountExport.js';
import { sendEmail, emailShell } from '../_lib/email.js';
import { enforce, getClientIp } from '../_lib/rate-limit.js';
import { requireSameOrigin } from '../_lib/security.js';
import { methodNotAllowed, ok, serverError, badRequest } from '../_lib/json.js';

// Resend caps total message size around 40MB; base64 inflates ~33%. Keep a
// safe ceiling on the RAW JSON so the encoded attachment stays under that.
const MAX_EMAIL_ATTACH_BYTES = 18 * 1024 * 1024; // 18 MB raw

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  if (req.method === 'GET') return streamDownload(req, res);
  if (req.method === 'POST') return emailCopy(req, res);
  return methodNotAllowed(res, ['GET', 'POST']);
}

async function streamDownload(req, res) {
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const payload = await buildAccountExport(user);

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${exportFilename()}"`);
    res.setHeader('Cache-Control', 'no-store');

    // Stream section-by-section so a large export doesn't buffer to a
    // single OOM-prone string. Still one valid JSON document.
    res.status(200);
    res.write('{\n');
    res.write(`  "ivy_export_version": 1,\n`);
    res.write(`  "exported_at": ${JSON.stringify(payload.exported_at)},\n`);
    const keys = Object.keys(payload).filter((k) => k !== 'ivy_export_version' && k !== 'exported_at');
    keys.forEach((k, i) => {
      res.write(`  ${JSON.stringify(k)}: ${JSON.stringify(payload[k], null, 2)}`);
      res.write(i === keys.length - 1 ? '\n' : ',\n');
    });
    res.write('}\n');
    return res.end();
  } catch (err) {
    return serverError(res, err);
  }
}

async function emailCopy(req, res) {
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!user.email) return badRequest(res, 'Your account has no email on file.');

    // Building + emailing the whole account is expensive; cap it hard.
    const ip = getClientIp(req);
    const blocked = await enforce(req, res, [
      { key: `export-email:user:${user.id}`, max: 3, windowSeconds: 60 * 60 },
      { key: `export-email:ip:${ip}`,        max: 6, windowSeconds: 60 * 60 },
    ]);
    if (blocked) return;

    const payload = await buildAccountExport(user);
    const json = JSON.stringify(payload, null, 2);
    const bytes = Buffer.byteLength(json, 'utf8');
    const filename = exportFilename();

    const tooBig = bytes > MAX_EMAIL_ATTACH_BYTES;
    const sizeMb = (bytes / (1024 * 1024)).toFixed(1);

    const body = tooBig
      ? `<p>Hi ${escapeHtml((user.name || '').split(/\s+/)[0] || 'there')},</p>
         <p>You asked for a copy of your Ivy OS data. It turned out to be a bit large
         to email safely (about ${sizeMb} MB), so we couldn't attach it here.</p>
         <p>You can download the complete file any time from
         <strong>Account → Your data → Export everything</strong>.</p>`
      : `<p>Hi ${escapeHtml((user.name || '').split(/\s+/)[0] || 'there')},</p>
         <p>As requested, your complete Ivy OS data export is attached to this email
         as <strong>${escapeHtml(filename)}</strong> (${sizeMb} MB of JSON).</p>
         <p>It includes your profile, clients, bookings, invoices, documents,
         messages, and everything else tied to your account. Keep it somewhere safe -
         it's a full copy of your data.</p>
         <p>You didn't request this? You can ignore the email, then change your
         password and review your security settings to be safe.</p>`;

    const html = emailShell({
      heading: 'Your data export',
      body,
      footer: `Requested from your account on ${new Date().toUTCString()}.`,
    });

    await sendEmail({
      to: user.email,
      subject: tooBig ? 'Your Ivy OS data export (download from your account)' : 'Your Ivy OS data export is attached',
      html,
      timeoutMs: 20000,
      attachments: tooBig ? undefined : [{
        filename,
        content: Buffer.from(json, 'utf8').toString('base64'),
        contentType: 'application/json',
      }],
    });

    return ok(res, { emailed: true, attached: !tooBig, bytes });
  } catch (err) {
    return serverError(res, err);
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
