// /api/cron/review-requests - daily at 17:00 UTC.
//
// Walks bookings that completed 2–14 days ago, haven't been asked yet,
// don't already have a review, and have a client email - for each,
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
import { makeBrandingCache } from '../_lib/branding.js';
import { generateRawToken, appUrl } from '../_lib/tokens.js';
import { ok, serverError, unauthorized } from '../_lib/json.js';
import { ensureSchemaApplied } from '../_lib/ensureSchema.js';
import crypto from 'node:crypto';
import { trackCron } from '../_lib/cronMetrics.js';

const MIN_DAYS_AFTER = 2;
const MAX_DAYS_AFTER = 14;
const MAX_PER_RUN = 100;

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Bookings with an occurrence that COMPLETED in the 2–14 day window -
// keyed on completion_log entries, NOT b.date. The old
// `b.date BETWEEN window AND completion_log ? b.date` form only matched
// single bookings (and a recurring series' very first occurrence), so
// recurring clients were NEVER asked. We still send at most one request
// per booking (the model is one review per booking row), using the most
// recent in-window completed occurrence for the email's date label.
// completion_log keys are validated YYYY-MM-DD on write, so ::date is safe.
// Exported for testing.
export async function selectDueReviewRequests() {
  const { rows } = await sql`
    SELECT b.id, b.workspace_id, b.client_id, b.client_name, b.client_email,
           b.service_id, b.date, b.start_min,
           s.name AS service_name,
           cs.biz_name,
           (SELECT MAX(k::date)
              FROM jsonb_object_keys(b.completion_log) AS k
             WHERE k::date BETWEEN CURRENT_DATE - ${MAX_DAYS_AFTER} * INTERVAL '1 day'
                               AND CURRENT_DATE - ${MIN_DAYS_AFTER} * INTERVAL '1 day'
           ) AS completed_date
      FROM bookings b
      LEFT JOIN services s ON s.id = b.service_id AND s.workspace_id = b.workspace_id
      LEFT JOIN calendar_settings cs ON cs.workspace_id = b.workspace_id
     WHERE b.cancelled_at IS NULL
       AND b.no_show_at IS NULL
       AND b.review_requested_at IS NULL
       AND b.client_email IS NOT NULL AND b.client_email <> ''
       AND b.completion_log <> '{}'::jsonb
       AND EXISTS (
             SELECT 1 FROM jsonb_object_keys(b.completion_log) AS k
              WHERE k::date BETWEEN CURRENT_DATE - ${MAX_DAYS_AFTER} * INTERVAL '1 day'
                                AND CURRENT_DATE - ${MIN_DAYS_AFTER} * INTERVAL '1 day'
           )
       AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.booking_id = b.id)
     ORDER BY completed_date DESC
     LIMIT ${MAX_PER_RUN}
  `;
  return rows;
}

async function handler(req, res) {
  const cronAuth = !!process.env.CRON_SECRET
    && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
  const adminAuth = process.env.ADMIN_SECRET
    && req.headers['x-admin-secret'] === process.env.ADMIN_SECRET;
  const userAuth = !cronAuth && !adminAuth ? await isSuperAdminBySession(req) : false;
  if (!cronAuth && !adminAuth && !userAuth) return unauthorized(res);

  try {
    await ensureSchemaApplied();
    const due = { rows: await selectDueReviewRequests() };

    let sent = 0;
    let failed = 0;
    const getBranding = makeBrandingCache();

    for (const r of due.rows) {
      try {
        const raw = generateRawToken(32);
        const hash = crypto.createHash('sha256').update(raw).digest('hex');
        const branding = await getBranding(r.workspace_id);
        const business = branding.businessName || r.biz_name || 'Your business';
        const occDate = r.completed_date || r.date;
        const dateLabel = (occDate instanceof Date ? occDate : new Date(occDate + 'T00:00:00Z'))
          .toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
        const link = `${appUrl()}/review/${encodeURIComponent(raw)}`;

        // Pre-rated quick-action links - clicking a star on the email
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
            footer: `One-time link - once you submit, this email's link won't work again. Your review is published to ${escapeHtml(business)}'s public profile.`,
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

export default trackCron('review-requests', handler);
