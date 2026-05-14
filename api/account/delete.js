// POST /api/account/delete — irreversibly deletes the authenticated user's
// account and every row tied to it.
//
// Safety:
//   • Requires a JSON body { confirmEmail } that matches the user's email
//     (server-side check), so a malicious tab can't trigger deletion just
//     by sliding past CSRF.
//   • Requires the same-origin check + authenticated session.
//
// Cascade strategy: workspaces.owner_id has ON DELETE CASCADE → deleting
// the user row drops the workspace, which cascades to every workspace-
// scoped table. auth_tokens.user_id also cascades. We don't keep server
// logs of personal data so there's nothing more to scrub.
//
// After delete we clear the session cookie so the browser is signed out.
import { sql } from '../_lib/db.js';
import { requireUser, clearSessionCookie } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { sendEmail, emailShell } from '../_lib/email.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;

  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const body = await readBody(req);
    const confirmEmail = (body.confirmEmail || '').toString().trim().toLowerCase();

    if (!confirmEmail) {
      return badRequest(res, 'confirmEmail is required');
    }
    if (confirmEmail !== (user.email || '').toLowerCase()) {
      return badRequest(res, "Email doesn't match the account we're about to delete");
    }

    // Snapshot identity for the confirmation email before the DELETE
    // cascade wipes the row.
    const userEmail = user.email;
    const userName = user.name || '';

    // Delete the user. Cascades to workspaces → all workspace-scoped tables,
    // and to auth_tokens. Returns the row count for sanity.
    const r = await sql`DELETE FROM users WHERE id = ${user.id}`;

    clearSessionCookie(res);

    // Confirmation email — bypasses prefs since the user opted in by
    // running the destructive action. Best-effort; deletion already
    // succeeded so the API ack doesn't depend on email delivery.
    if (r.rowCount > 0 && userEmail) {
      try {
        await sendEmail({
          to: userEmail,
          subject: 'Your THRYVE account was deleted',
          html: emailShell({
            heading: 'Your account is deleted',
            body: `<p>Hi ${userName ? userName.split(/\s+/)[0] : 'there'},</p>
              <p>Per your request, we've fully deleted your THRYVE account and everything tied to it — your workspace, clients, bookings, invoices, documents, and messages. This action can't be reversed.</p>
              <p>If you didn't make this request, please email us right away — we still have backups for 30 days that we can restore from in case of unauthorized deletion.</p>`,
            footer: 'Thanks for trying THRYVE. We\'re sorry to see you go — if you have a moment, reply with what we could have done better.',
          }),
        });
      } catch (mailErr) {
        // eslint-disable-next-line no-console
        console.error('[account/delete] confirmation email failed:', mailErr.message);
      }
    }

    return ok(res, { deleted: r.rowCount > 0 });
  } catch (err) {
    return serverError(res, err);
  }
}
