// /api/cron/review-requests — daily at 17:00 UTC.
//
// Walks bookings that completed 2–14 days ago, haven't been asked yet,
// don't already have a review, and have a client email — for each,
// mints a one-time signed link and emails "How was it?". Submitting
// the review (or going past the 14-day window) nulls the token hash
// so it can't be reused.
//
// Branding-aware: emails come from the OWNER'S brand (their logo,
// accent color, signature), so the request feels personal instead of
// system-y. Reviews drive the workspace's public booking page rating
// + the Discover listing star count, so this cron compounds growth.
import { sql } from '../_lib/db.js';
import { reportError } from '../_lib/monitoring.js';
import { isSuperAdminBySession } from '../_lib/admin.js';
import { sendEmailToClient, emailShell } from '../_lib/email.js';
import { fetchBranding } from '../_lib/branding.js';
import { generateRawToken, appUrl } from '../_lib/tokens.js';
import { ok, serverError, unauthorized } from '../_lib/json.js';
import { ensureSchemaApplied } from '../_lib/ensureSchema.js';
import crypto from 'node:crypto';

const MIN_DAYS_AFTER = 2;
const MAX_DAYS_AFTER = 14;
const MAX_PER_RUN = 100;

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export default async function handler(req, res) {
  const cronAuth = !!process.env.CRON_SECRET
    && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
  const adminAuth = process.env.ADMIN_SECRET
    && req.headers['x-admin-secret'] === process.env.ADMIN_SECRET;
  const userAuth = !cronAuth && !adminAuth ? await isSuperAdminBySession(req) : false;
  if (!cronAuth && !adminAuth && !userAuth) return unauthorized(res);

  try {
    await ensureSchemaApplied();
    const due = await sql`
      SELECT b.id, b.workspace_id, b.client_id, b.client_name, b.client_email,
             b.service_id, b.date, b.start_min,
             s.name AS service_name,
             cs.biz_name
        FROM bookings b
        LEFT JOIN services s ON s.id = b.service_id AND s.workspace_id = b.workspace_id
        LEFT JOIN calendar_settings cs ON cs.workspace_id = b.workspace_id
       WHERE b.cancelled_at IS NULL
         AND b.review_requested_at IS NULL
         AND b.client_email IS NOT NULL AND b.client_email <> ''
         AND b.date BETWEEN CURRENT_DATE - ${MAX_DAYS_AFTER} * INTERVAL '1 day'
                        AND CURRENT_DATE - ${MIN_DAYS_AFTER} * INTERVAL '1 day'
         AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.booking_id = b.id)
       ORDER BY b.date DESC
       LIMIT ${MAX_PER_RUN}
    `;

    let sent = 0;
    let failed = 0;

    for (const r of due.rows) {
      try {
        const raw = generateRawToken(32);
        const hash = crypto.createHash('sha256').update(raw).digest('hex');
        const branding = await fetchBranding(r.workspace_id);
        const business = branding.businessName || r.biz_name || 'Your business';
        const dateLabel = (r.date instanceof Date ? r.date : new Date(r.date + 'T00:00:00Z'))
          .toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
        const link = `${appUrl()}/review/${encodeURIComponent(raw)}`;

        // Pre-rated quick-action links — clicking a star on the email
        // takes them straight to the form with that rating selected.
        const quickStars = [1, 2, 3, 4, 5].map((n) =>
          `<a href="${link}?rating=${n}" style="text-decoration:none;font-size:28px;line-height:1;padding:0 4px;color:#E0B645;">${'★'.repeat(n)}${'☆'.repeat(5 - n)}</a>`
        ).join('<br/>');

        await sendEmailToClient({
          clientId: r.client_id, type: 'marketing',
          to: r.client_email,
          subject: `How was your ${r.service_name || 'session'}?`,
          replyTo: branding.replyTo,
          html: emailShell({
            heading: `How was your ${r.service_name || 'session'}?`,
            body: `<p>Hi ${escapeHtml((r.client_name || '').split(/\s+/)[0] || 'there')},</p>
              <p>Hope your <strong>${escapeHtml(r.service_name || 'session')}</strong> with
              <strong>${escapeHtml(business)}</strong> on ${escapeHtml(dateLabel)} went well.</p>
              <p>Would you mind taking a moment to share how it went? Reviews help small businesses like ${escapeHtml(business)} thrive.</p>
              <p style="text-align:center;margin:24px 0 8px;font-size:14px;color:#85827B;">Tap to rate:</p>
              <p style="text-align:center;line-height:1.7;">
                <a href="${link}?rating=5" style="text-decoration:none;font-size:30px;letter-spacing:4px;color:#E0B645;">★ ★ ★ ★ ★</a>
              </p>`,
            ctaText: 'Leave a review',
            ctaUrl: link,
            footer: `One-time link — once you submit, this email's link won't work again. Only ${escapeHtml(business)} sees the review until they choose to publish it.`,
            branding,
          }),
        });

        await sql`
          UPDATE bookings SET
            review_request_token_hash = ${hash},
            review_requested_at = NOW(),
            updated_at = NOW()
          WHERE id = ${r.id}
        `;
        sent++;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[cron/review-requests] failed for booking', r.id, err.message);
        failed++;
        try { reportError(err, { extra: { bookingId: r.id } }); } catch { /* ignore */ }
      }
    }

    return ok(res, { considered: due.rows.length, sent, failed });
  } catch (err) {
    return serverError(res, err);
  }
}
