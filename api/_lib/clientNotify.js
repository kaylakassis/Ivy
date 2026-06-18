// Client-onboarding emails - owner-side actions (add client, CSV import,
// even imports through the public booking flow if you want to wire them
// later) trigger a one-shot "claim your account" invite. Skip if no
// email, idempotent via clients.invite_sent_at so rapid edits / re-saves
// don't spam.
import { sql } from './db.js';
import { sendEmailToClient, emailShell } from './email.js';
import { fetchBranding } from './branding.js';
import { appUrl } from './tokens.js';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function firstName(s) { return (s || '').trim().split(/\s+/)[0] || ''; }

// Best-effort fire-and-forget invite. Fail silently - never block the
// owner's create / import call.
export async function sendClientInvite({ workspaceId, clientId }) {
  try {
    const { rows } = await sql`
      SELECT c.id, c.name, c.email, c.invite_sent_at,
             cs.biz_name, cs.slug
      FROM clients c
      LEFT JOIN calendar_settings cs ON cs.workspace_id = c.workspace_id
      WHERE c.id = ${clientId} AND c.workspace_id = ${workspaceId}
    `;
    const c = rows[0];
    if (!c) return;
    if (!c.email) return;            // can't invite without an inbox
    if (c.invite_sent_at) return;    // already invited; idempotent (fast path)

    // Atomically claim the invite BEFORE sending so two near-simultaneous
    // first-adds for the same client can't both email. Only the request
    // that stamps invite_sent_at (from NULL) proceeds. Released on failure.
    const claim = await sql`
      UPDATE clients SET invite_sent_at = NOW()
      WHERE id = ${clientId} AND workspace_id = ${workspaceId} AND invite_sent_at IS NULL
      RETURNING id
    `;
    if (claim.rowCount === 0) return; // a concurrent add already claimed it

    // Deliberately broad: every workspace-add gets one invite. The
    // signup path auto-claims existing clients-rows with matching
    // email at verification time, so the link works whether or not
    // they already have an Ivy OS account.
    const base = appUrl();
    const signinHref  = `${base}/signin?email=${encodeURIComponent(c.email)}`;
    // mode=client so the signup form preselects the client role and the
    // invitee claims their portal instead of accidentally creating a
    // business workspace.
    const signupHref  = `${base}/signup?mode=client&email=${encodeURIComponent(c.email)}`;
    const bizName     = c.biz_name || 'Your business';
    const bookingHref = c.slug ? `${base}/book/${encodeURIComponent(c.slug)}` : null;
    const branding = await fetchBranding(workspaceId);

    try {
    await sendEmailToClient({
      clientId,
      // Invitations are tied to the bookings vertical - opting out of
      // booking emails also disables the invite reminder. Reasonable
      // since the invite IS about future bookings.
      type: 'bookings',
      to: c.email,
      subject: `${bizName} added you on Ivy OS`,
      replyTo: branding.replyTo,
      html: emailShell({
        heading: `${bizName} added you on Ivy OS`,
        branding,
        body: `<p>Hi${firstName(c.name) ? ` ${escapeHtml(firstName(c.name))}` : ''},</p>
          <p><strong>${escapeHtml(bizName)}</strong> added you to their Ivy OS
          account, which means you'll get bookings, invoices, and
          documents from them all in one place.</p>
          <p>Create a free Ivy OS account (or sign in if you already have
          one) to see everything in your portal:</p>
          <ul style="margin:0 0 16px 16px;padding:0;">
            <li>Upcoming + past bookings</li>
            <li>Invoices, payments, and receipts</li>
            <li>Forms to sign before sessions</li>
            <li>Direct messages with ${escapeHtml(bizName)}</li>
          </ul>
          <p style="font-size:13px;color:#85827B;">
            The client portal on Ivy OS is always free.
            ${bookingHref ? `If you'd rather just book a session, use
              <a href="${bookingHref}" style="color:#2E3168;">${bookingHref}</a>.` : ''}
          </p>`,
        ctaText: 'Create my account',
        ctaUrl: signupHref,
        footer: `Already have an Ivy OS account? <a href="${signinHref}" style="color:#2E3168;">Sign in instead</a> - we'll link you to ${escapeHtml(bizName)} automatically.`,
      }),
    });
    } catch (sendErr) {
      // Send failed - release the claim so a later add/retry can re-invite.
      await sql`
        UPDATE clients SET invite_sent_at = NULL
        WHERE id = ${clientId} AND workspace_id = ${workspaceId}
      `.catch(() => {});
      throw sendErr;
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[client-invite] failed for client', clientId, err.message);
  }
}
