// Notifications for package lifecycle events. v1 covers the most useful
// trigger: "this client just used their last credit." The owner gets a
// push + email so they can offer a renewal before the relationship goes
// quiet.
//
// Fires from /api/calendar/bookings AFTER the booking row is inserted —
// see packageExhaustionEvent in that handler.
import { sql } from './db.js';
import { sendEmailToUser, emailShell } from './email.js';
import { notifyOwnerSafe } from './push.js';
import { fetchBranding } from './branding.js';
import { appUrl } from './tokens.js';
import { reportError } from './monitoring.js';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export async function notifyPackageExhausted({ workspaceId, clientPackageId, clientId }) {
  try {
    const { rows } = await sql`
      SELECT
        cp.id AS package_id, cp.name AS package_name,
        cp.credits_total, cp.expires_at,
        c.id AS client_id, c.name AS client_name, c.email AS client_email,
        w.owner_id,
        u.email AS owner_email, u.name AS owner_name
      FROM client_packages cp
      JOIN clients c ON c.id = cp.client_id
      JOIN workspaces w ON w.id = cp.workspace_id
      LEFT JOIN users u ON u.id = w.owner_id
      WHERE cp.id = ${clientPackageId}
        AND cp.workspace_id = ${workspaceId}
        AND cp.client_id = ${clientId}
      LIMIT 1
    `;
    const r = rows[0];
    if (!r) return;

    const branding = await fetchBranding(workspaceId);
    const clientName = r.client_name || 'Your client';

    // Push (owner-side) — short, actionable, links to the client drawer.
    notifyOwnerSafe({
      workspaceId,
      type: 'bookings',
      payload: {
        title: `${clientName} is out of sessions`,
        body: `${r.package_name} fully consumed (${r.credits_total} of ${r.credits_total} used). Time to offer a renewal?`,
        url: `/clients?open=${encodeURIComponent(r.client_id)}`,
        tag: `pkg-exhausted-${r.package_id}`,
      },
    });

    // Email (owner-side) — same beat but with more context + a direct
    // CTA into the client drawer where the owner can sell another pack.
    if (r.owner_email) {
      const greeting = r.owner_name ? `Hi ${escapeHtml(r.owner_name.split(/\s+/)[0])},` : 'Hi,';
      const html = emailShell({
        heading: `${escapeHtml(clientName)} is out of sessions`,
        branding,
        body: `<p>${greeting}</p>
          <p><strong>${escapeHtml(clientName)}</strong> just used the last credit on <strong>${escapeHtml(r.package_name)}</strong>.</p>
          <p>Good moment to offer a renewal — they're booking actively and won't have credits for next time.</p>`,
        ctaText: 'Open client',
        ctaUrl: `${appUrl()}/clients?open=${encodeURIComponent(r.client_id)}`,
        footer: `Adjust which alerts you receive from Account → Notifications.`,
      });
      await sendEmailToUser({
        userId: r.owner_id, type: 'bookings',
        to: r.owner_email,
        subject: `${clientName} is out of sessions — offer a renewal?`,
        html,
      });
    }
  } catch (err) {
    console.error('[notifyPackageExhausted] failed:', err.message);
    reportError(err, { extra: { clientPackageId, workspaceId } });
  }
}
