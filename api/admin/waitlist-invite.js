// POST /api/admin/waitlist-invite  { id }
//
// Invite one person off the waitlist while launch mode is "waitlist".
// Emails them a personal link (/signup?invite=<signed token>, 30 days)
// that lets exactly that signup through the gate, marks the row
// "invited", and returns the link so the operator can also text it.
// Deleting the row in Admin revokes the link.
import { sql } from '../_lib/db.js';
import { requireSameOrigin } from '../_lib/security.js';
import { requireSuperAdmin, getAdminActor } from '../_lib/admin.js';
import { recordAudit } from '../_lib/audit.js';
import { readBody } from '../_lib/body.js';
import { makeInviteToken } from '../_lib/earlyAccess.js';
import { appUrl } from '../_lib/tokens.js';
import { sendEmail, emailShell } from '../_lib/email.js';
import { badRequest, methodNotAllowed, notFound, ok, serverError } from '../_lib/json.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  if (!(await requireSuperAdmin(req, res))) return;
  try {
    const body = await readBody(req);
    const id = String(body?.id || '');
    if (!/^[0-9a-f-]{36}$/i.test(id)) return badRequest(res, 'id is required');
    const { rows } = await sql`SELECT id, email, first_name, name, status FROM waitlist_signups WHERE id = ${id}`;
    const row = rows[0];
    if (!row) return notFound(res, 'Not on the waitlist');

    const token = makeInviteToken(row.id, row.email);
    const link = `${appUrl()}/signup?invite=${encodeURIComponent(token)}`;
    const first = (row.first_name || (row.name || '').split(/\s+/)[0] || '').trim();

    let emailed = false;
    try {
      await sendEmail({
        to: row.email,
        subject: "You're in: your Ivy invite",
        html: emailShell({
          heading: first ? `${esc(first)}, you're in.` : "You're in.",
          body: `<p>Your spot on the Ivy waitlist just came up. This link is yours alone and works for 30 days:</p>
                 <p style="margin:18px 0"><a href="${esc(link)}" style="display:inline-block;padding:12px 20px;background:#4CBA7F;color:#012B24;border-radius:10px;text-decoration:none;font-weight:600">Create my Ivy account</a></p>
                 <p>If the button doesn't work, paste this into your browser:<br><span style="word-break:break-all">${esc(link)}</span></p>
                 <p>See you inside.</p>`,
          footer: 'You received this because you joined the Ivy waitlist and asked to hear from us.',
        }),
      });
      emailed = true;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[waitlist-invite] email failed:', e.message);
    }

    await sql`
      UPDATE waitlist_signups
         SET invited_at = NOW(),
             status = CASE WHEN status = 'converted' THEN status ELSE 'invited' END
       WHERE id = ${row.id}`;
    const actor = await getAdminActor(req);
    await recordAudit(req, { actor, action: 'admin.waitlist.invite', meta: { id: row.id, emailed } });
    return ok(res, { ok: true, link, emailed });
  } catch (err) {
    return serverError(res, err);
  }
}
