// POST /api/cancellation-policy/request   body { bookingId }
//
// Owner only. For a booking the business made itself (no client
// acceptance), email the client a link to read and accept the current
// cancellation policy. The link is single-use, expires in 30 days and only
// its sha256 is stored. One email per booking per 10 minutes, and a
// per-workspace hourly cap.
import crypto from 'node:crypto';
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { enforce } from '../_lib/rate-limit.js';
import { generateRawToken, appUrl } from '../_lib/tokens.js';
import { sendEmailToClient, emailShell } from '../_lib/email.js';
import { fetchBranding } from '../_lib/branding.js';
import { getCurrentPolicy, escapeHtml } from '../_lib/cancellationPolicy.js';
import { badRequest, methodNotAllowed, notFound, ok, serverError } from '../_lib/json.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
    if (await enforce(req, res, [{ key: `cpolicy-request:ws:${workspaceId}`, max: 50, windowSeconds: 3600 }])) return;

    const body = await readBody(req);
    const bookingId = body?.bookingId ? String(body.bookingId) : '';
    if (!UUID.test(bookingId)) return badRequest(res, 'bookingId is required');

    const { rows } = await sql`
      SELECT b.id, b.client_id, b.date, b.start_min, b.cancelled_at,
             c.name AS client_name, c.email AS client_email,
             s.name AS service_name, cs.biz_name, cs.slug
        FROM bookings b
        LEFT JOIN clients c ON c.id = b.client_id AND c.workspace_id = b.workspace_id
        LEFT JOIN services s ON s.id = b.service_id AND s.workspace_id = b.workspace_id
        LEFT JOIN calendar_settings cs ON cs.workspace_id = b.workspace_id
       WHERE b.id = ${bookingId} AND b.workspace_id = ${workspaceId}
       LIMIT 1
    `;
    const b = rows[0];
    if (!b) return notFound(res, 'Booking not found');
    if (b.cancelled_at) return badRequest(res, 'This booking is cancelled.');
    if (!b.client_id || !b.client_email) return badRequest(res, 'Add an email for this client first.');
    if (!b.slug) return badRequest(res, 'Set up your booking page first.');
    const policy = await getCurrentPolicy(workspaceId);
    if (!policy) return badRequest(res, 'Write your cancellation policy first.');

    const recent = await sql`
      SELECT 1 FROM cancellation_policy_requests
       WHERE workspace_id = ${workspaceId} AND booking_id = ${bookingId}
         AND created_at > NOW() - INTERVAL '10 minutes'
       LIMIT 1
    `;
    if (recent.rows.length > 0) return badRequest(res, 'You just sent this. Give it a few minutes before sending again.');

    const raw = generateRawToken(32);
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    await sql`
      INSERT INTO cancellation_policy_requests (workspace_id, client_id, booking_id, token_hash, sent_to, expires_at)
      VALUES (${workspaceId}, ${b.client_id}, ${bookingId}, ${hash}, ${b.client_email}, NOW() + INTERVAL '30 days')
    `;
    const link = `${appUrl()}/book/${encodeURIComponent(b.slug)}/policy?t=${encodeURIComponent(raw)}`;
    const biz = b.biz_name || 'your business';
    const first = String(b.client_name || '').trim().split(/\s+/)[0];
    const dateISO = b.date instanceof Date ? b.date.toISOString().slice(0, 10) : String(b.date).slice(0, 10);
    const branding = await fetchBranding(workspaceId);
    const html = emailShell({
      heading: 'Please review the cancellation policy',
      branding,
      body: `<p>${first ? `Hi ${escapeHtml(first)},` : 'Hi,'}</p>
        <p>${escapeHtml(biz)} asks you to read and agree to their cancellation policy for your ${escapeHtml(b.service_name || 'appointment')} on ${escapeHtml(dateISO)}.</p>
        <p>It only takes a moment.</p>`,
      ctaText: 'Read the policy',
      ctaUrl: link,
      footer: `Questions? Reply to this email to reach ${escapeHtml(biz)}.`,
    });
    const sent = await sendEmailToClient({
      clientId: b.client_id, workspaceId, type: 'bookings', to: b.client_email,
      subject: `${biz}: please review the cancellation policy`, html, replyTo: branding?.replyTo,
    });
    return ok(res, { sent: !!sent?.sent, sentTo: b.client_email, reason: sent?.sent ? null : (sent?.reason || null) });
  } catch (err) {
    return serverError(res, err);
  }
}
