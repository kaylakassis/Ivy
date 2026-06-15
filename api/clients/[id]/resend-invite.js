// POST /api/clients/:id/resend-invite
//
// Re-sends the "claim your portal account" invitation to the client.
// Bypasses sendClientInvite's idempotency guard (it skips if
// invite_sent_at is set) so the owner can nudge a slow-claimer.
//
// Updates clients.invite_sent_at to NOW() either way so the audit trail
// reflects when the latest invite went out.
import { sql } from '../../_lib/db.js';
import { requireUser } from '../../_lib/auth.js';
import { ensureActiveWorkspace } from '../../_lib/workspaceGate.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { fetchOwnedClient } from '../../_lib/clients.js';
import { sendEmailToClient, emailShell } from '../../_lib/email.js';
import { fetchBranding } from '../../_lib/branding.js';
import { appUrl } from '../../_lib/tokens.js';
import { withIdempotency } from '../../_lib/idempotency.js';
import { methodNotAllowed, serverError } from '../../_lib/json.js';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function firstName(s) { return (s || '').trim().split(/\s+/)[0] || ''; }

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
    const { id: clientId } = req.query;

    // Idempotent wrap — a double-click on Resend invite used to fire
    // two invitation emails to the same address.
    const idemp = await withIdempotency(req, user.id, async () => doResendInvite());
    if (idemp.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return res.status(idemp.status).json(idemp.body);

    async function doResendInvite() {
    const client = await fetchOwnedClient({ id: clientId, workspaceId });
    if (!client) return { status: 404, body: { error: 'Client not found' } };
    if (!client.email) return { status: 400, body: { error: 'No email on file for this client' } };
    if (client.user_id) return { status: 400, body: { error: 'Client has already claimed their portal account' } };

    const branding = await fetchBranding(workspaceId);
    const bizName = branding.businessName || 'Your business';
    const base = appUrl();
    const signinHref = `${base}/signin?email=${encodeURIComponent(client.email)}`;
    // mode=client so the invitee lands on the client signup (claims
    // their portal) rather than creating a business workspace.
    const signupHref = `${base}/signup?mode=client&email=${encodeURIComponent(client.email)}`;

    const result = await sendEmailToClient({
      clientId, type: 'bookings',
      to: client.email,
      subject: `Reminder: claim your account with ${bizName}`,
      replyTo: branding.replyTo,
      html: emailShell({
        heading: `Claim your account with ${escapeHtml(bizName)}`,
        branding,
        body: `<p>Hi${firstName(client.name) ? ` ${escapeHtml(firstName(client.name))}` : ''},</p>
          <p>This is a quick reminder that <strong>${escapeHtml(bizName)}</strong> set you up with a
          THRYVE portal — it's where you'll see your bookings, invoices, and any messages from them.</p>
          <p>Create your free account (or sign in if you already have one) to get started.</p>`,
        ctaText: 'Create my account',
        ctaUrl: signupHref,
        footer: `Already have a THRYVE account? <a href="${signinHref}" style="color:#2E3168;">Sign in instead</a> — we'll link you to ${escapeHtml(bizName)} automatically.`,
      }),
    });

    await sql`UPDATE clients SET invite_sent_at = NOW() WHERE id = ${clientId} AND workspace_id = ${workspaceId}`;

    return {
      status: 200,
      body: {
        sent: result.sent,
        reason: result.reason || null,
      },
    };
    } // end doResendInvite
  } catch (err) {
    return serverError(res, err);
  }
}
