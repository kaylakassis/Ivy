// Client-onboarding emails - owner-side actions (add client, Ivy's
// add_client, a booking that creates a new client, opted-in imports)
// trigger a one-shot "claim your account" invite. Skip if no email,
// idempotent via clients.invite_sent_at so rapid edits / re-saves don't
// spam.
//
// The business decides whether new clients get it automatically:
// calendar_settings.invite_new_clients (NULL / TRUE = yes, FALSE = no).
// See inviteNewClientsEnabled() below. Imports ignore the setting and stay
// quiet unless the owner ticks "send invites" for that import.
//
// invite_sent_at is only left set when the email really went out: a
// muted client (opted out of booking emails), the daily send cap or a
// provider failure releases it, so the owner never sees "Invite sent" for
// an invite nobody received.
import { sql } from './db.js';
import { sendEmailToClient, emailShell } from './email.js';
import { fetchBranding } from './branding.js';
import { appUrl } from './tokens.js';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function firstName(s) { return (s || '').trim().split(/\s+/)[0] || ''; }

// Does this business invite new clients automatically? Default yes (the
// column is NULL until the owner changes the setting). A lookup failure
// answers "no": an invite is never sent on a guess.
export async function inviteNewClientsEnabled(workspaceId) {
  if (!workspaceId) return false;
  try {
    const { rows } = await sql`SELECT invite_new_clients FROM calendar_settings WHERE workspace_id = ${workspaceId}`;
    return rows[0]?.invite_new_clients !== false;
  } catch {
    return false;
  }
}

// Best-effort invite. Never throws - never blocks the owner's create /
// import call. Returns { sent: boolean, reason?: string } so callers that
// await it can show "Invite sent" honestly:
//   reason: 'no-email' | 'already-invited' | 'not-found' | 'muted'
//           | 'workspace-quota-exceeded' | <provider error>
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
    if (!c) return { sent: false, reason: 'not-found' };
    if (!c.email) return { sent: false, reason: 'no-email' };                 // can't invite without an inbox
    if (c.invite_sent_at) return { sent: false, reason: 'already-invited' };  // idempotent (fast path)

    // Atomically claim the invite BEFORE sending so two near-simultaneous
    // first-adds for the same client can't both email. Only the request
    // that stamps invite_sent_at (from NULL) proceeds. Released on failure.
    const claim = await sql`
      UPDATE clients SET invite_sent_at = NOW()
      WHERE id = ${clientId} AND workspace_id = ${workspaceId} AND invite_sent_at IS NULL
      RETURNING id
    `;
    if (claim.rowCount === 0) return { sent: false, reason: 'already-invited' }; // a concurrent add claimed it

    // Deliberately broad: every workspace-add gets one invite. The
    // signup path auto-claims existing clients-rows with matching
    // email at verification time, so the link works whether or not
    // they already have an Ivy account.
    const base = appUrl();
    const signinHref  = `${base}/signin?email=${encodeURIComponent(c.email)}`;
    // mode=client so the signup form preselects the client role and the
    // invitee claims their portal instead of accidentally creating a
    // business workspace.
    const signupHref  = `${base}/signup?mode=client&email=${encodeURIComponent(c.email)}`;
    const bizName     = c.biz_name || 'Your business';
    const bookingHref = c.slug ? `${base}/book/${encodeURIComponent(c.slug)}` : null;
    const branding = await fetchBranding(workspaceId);

    let result;
    try {
    result = await sendEmailToClient({
      clientId,
      // Invitations are tied to the bookings vertical - opting out of
      // booking emails also disables the invite reminder. Reasonable
      // since the invite IS about future bookings.
      type: 'bookings',
      to: c.email,
      subject: `${bizName} added you on Ivy`,
      replyTo: branding.replyTo,
      html: emailShell({
        heading: `${bizName} added you on Ivy`,
        branding,
        body: `<p>Hi${firstName(c.name) ? ` ${escapeHtml(firstName(c.name))}` : ''},</p>
          <p><strong>${escapeHtml(bizName)}</strong> added you to their Ivy
          account, which means you'll get bookings, invoices, and
          documents from them all in one place.</p>
          <p>Create a free Ivy account (or sign in if you already have
          one) to see everything in your portal:</p>
          <ul style="margin:0 0 16px 16px;padding:0;">
            <li>Upcoming + past bookings</li>
            <li>Invoices, payments, and receipts</li>
            <li>Forms to sign before sessions</li>
            <li>Direct messages with ${escapeHtml(bizName)}</li>
          </ul>
          <p style="font-size:13px;color:#85827B;">
            The client portal on Ivy is always free.
            ${bookingHref ? `If you'd rather just book a session, use
              <a href="${bookingHref}" style="color:#2E3168;">${bookingHref}</a>.` : ''}
          </p>`,
        ctaText: 'Create my account',
        ctaUrl: signupHref,
        footer: `Already have an Ivy account? <a href="${signinHref}" style="color:#2E3168;">Sign in instead</a> - we'll link you to ${escapeHtml(bizName)} automatically.`,
      }),
    });
    } catch (sendErr) {
      result = { sent: false, reason: sendErr?.message || 'send failed' };
    }
    if (!result?.sent) {
      // Not delivered (muted, over the daily cap, provider error): release
      // the claim so the owner's view stays honest and a later resend can
      // go out.
      await sql`
        UPDATE clients SET invite_sent_at = NULL
        WHERE id = ${clientId} AND workspace_id = ${workspaceId}
      `.catch(() => {});
      return { sent: false, reason: result?.reason || 'not sent' };
    }
    return { sent: true };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[client-invite] failed for client', clientId, err.message);
    return { sent: false, reason: 'error' };
  }
}
