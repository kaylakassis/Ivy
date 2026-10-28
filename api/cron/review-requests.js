// /api/cron/review-requests - hourly.
//
// Asks a client "How was it?" 2 to 3 hours after a session they attended,
// which is when the experience is fresh and the ask converts best. A
// request goes out only when ALL of these hold:
//
//   • the occurrence is over: its end time (booking date + end_min, in the
//     workspace timezone) is at least 2 hours in the past, never before;
//   • the owner marked it completed / attended (completion_log has the
//     occurrence) and it is not a no-show or a cancellation;
//   • if the session has an invoice (bookings.collect_invoice_id), that
//     invoice is paid;
//   • this client has not been asked by this business in the last 30 days
//     (any booking of theirs with review_requested_at in the window);
//   • there is no block in either direction (contact_blocks) and the
//     client has not opted out of 'marketing' emails;
//   • the workspace is active (isWorkspaceActive) - archived or lapsed
//     businesses never email their clients;
//   • the booking has not been asked already and has no review.
//
// Occurrences older than 7 days drop out of the window (a late ask reads
// as spam). Submitting the review (or going past the window) nulls the
// token hash so the link cannot be reused. Owners moderate reviews from
// Finance as before - nothing here changes that.
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
import { isWorkspaceActive } from '../_lib/clientPortal.js';
import { ok, serverError, unauthorized } from '../_lib/json.js';
import { ensureSchemaApplied } from '../_lib/ensureSchema.js';
import crypto from 'node:crypto';
import { trackCron } from '../_lib/cronMetrics.js';

export const MIN_HOURS_AFTER = 2;
export const MAX_HOURS_AFTER = 7 * 24;
export const PER_CLIENT_COOLDOWN_DAYS = 30;
// Sized for ~100K active workspaces. sendEmail throttles at ~8/sec
// (Resend ceiling), so 1000 sends fits well inside the 300s cron budget.
const MAX_PER_RUN = 1000;

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Candidate bookings with a completed occurrence whose END fell between
// MAX_HOURS_AFTER and MIN_HOURS_AFTER ago, in the workspace's own timezone.
// Keyed on completion_log entries (one key per occurrence, YYYY-MM-DD,
// validated on write so ::date is safe), so recurring clients are asked
// too. One request per booking row; the most recent in-window occurrence
// provides the email's date label.
//
// Workspace activity is decided in JS (isWorkspaceActive is the single
// source of truth shared with the paywall), so the subscription columns
// ride along and dueReviewRequests() applies the filter.
// Exported for testing.
export async function selectDueReviewRequests({ now = null } = {}) {
  const nowTs = now ? new Date(now).toISOString() : null;
  const { rows } = await sql`
    WITH ref AS (SELECT COALESCE(${nowTs}::timestamptz, NOW()) AS now)
    SELECT b.id, b.workspace_id, b.client_id, b.client_name, b.client_email,
           b.service_id, b.date, b.start_min,
           s.name AS service_name,
           cs.biz_name, cs.slug,
           w.subscription_status, w.trial_ends_at, w.subscription_period_end, w.comp_until,
           (SELECT MAX(k::date)
              FROM jsonb_object_keys(b.completion_log) AS k, ref
             WHERE (k::date::timestamp + make_interval(mins => b.end_min)) AT TIME ZONE COALESCE(cs.timezone, 'UTC')
                   BETWEEN ref.now - make_interval(hours => ${MAX_HOURS_AFTER})
                       AND ref.now - make_interval(hours => ${MIN_HOURS_AFTER})
           ) AS completed_date
      FROM bookings b
      JOIN workspaces w ON w.id = b.workspace_id
      LEFT JOIN services s ON s.id = b.service_id AND s.workspace_id = b.workspace_id
      LEFT JOIN calendar_settings cs ON cs.workspace_id = b.workspace_id
      LEFT JOIN clients c ON c.id = b.client_id AND c.workspace_id = b.workspace_id
      LEFT JOIN invoices ci ON ci.id = b.collect_invoice_id AND ci.workspace_id = b.workspace_id
     WHERE b.cancelled_at IS NULL
       AND b.no_show_at IS NULL
       AND b.review_requested_at IS NULL
       AND b.client_email IS NOT NULL AND b.client_email <> ''
       AND b.completion_log <> '{}'::jsonb
       -- the session is over: at least MIN_HOURS_AFTER ago, at most MAX_HOURS_AFTER
       AND EXISTS (
             SELECT 1 FROM jsonb_object_keys(b.completion_log) AS k, ref
              WHERE (k::date::timestamp + make_interval(mins => b.end_min)) AT TIME ZONE COALESCE(cs.timezone, 'UTC')
                    BETWEEN ref.now - make_interval(hours => ${MAX_HOURS_AFTER})
                        AND ref.now - make_interval(hours => ${MIN_HOURS_AFTER})
           )
       -- an invoice for the session must be paid first
       AND (b.collect_invoice_id IS NULL OR ci.status = 'paid')
       -- not asked already, no review yet
       AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.booking_id = b.id)
       -- once per client per business per 30 days (by client row or by address)
       AND NOT EXISTS (
             SELECT 1 FROM bookings b2, ref
              WHERE b2.workspace_id = b.workspace_id
                AND b2.id <> b.id
                AND b2.review_requested_at IS NOT NULL
                AND b2.review_requested_at > ref.now - make_interval(days => ${PER_CLIENT_COOLDOWN_DAYS})
                AND ((b.client_id IS NOT NULL AND b2.client_id = b.client_id)
                     OR LOWER(b2.client_email) = LOWER(b.client_email))
           )
       -- blocked in either direction = no contact
       AND NOT EXISTS (
             SELECT 1 FROM contact_blocks cb
              WHERE cb.workspace_id = b.workspace_id AND cb.client_id = b.client_id
           )
       -- client opted out of review prompts / announcements
       AND COALESCE(c.notification_prefs->>'marketing', 'true') <> 'false'
     ORDER BY completed_date DESC
     LIMIT ${MAX_PER_RUN}
  `;
  return rows;
}

// The rows the handler acts on: candidates from an ACTIVE workspace only.
// Exported for testing.
export async function dueReviewRequests(opts = {}) {
  const rows = await selectDueReviewRequests(opts);
  return rows.filter((r) => isWorkspaceActive(r));
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
    const due = { rows: await dueReviewRequests() };

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
        // A "book again" nudge turns the review email into repeat business
        // for owners who have a public booking page.
        const rebookUrl = r.slug ? `${appUrl()}/book/${encodeURIComponent(r.slug)}` : null;

        // Pre-rated quick-action links - clicking a star on the email
        // takes them straight to the form with that rating selected.
        const quickStars = [1, 2, 3, 4, 5].map((n) =>
          `<a href="${link}?rating=${n}" style="text-decoration:none;font-size:28px;line-height:1;padding:0 4px;color:#E0B645;">${'★'.repeat(n)}${'☆'.repeat(5 - n)}</a>`
        ).join('<br/>');

        const sendRes = await sendEmailToClient({
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
              </p>${rebookUrl ? `
              <p style="text-align:center;margin:22px 0 0;font-size:14px;color:#85827B;">
                Ready to come back? <a href="${rebookUrl}" style="color:#4E63C7;font-weight:600;text-decoration:none;">Book your next ${escapeHtml(r.service_name || 'visit')}</a>.
              </p>` : ''}`,
            ctaText: 'Leave a review',
            ctaUrl: link,
            footer: `One-time link - once you submit, this email's link won't work again. Your review is published to ${escapeHtml(business)}'s public profile.`,
            branding,
          }),
        });

        // Only mark the booking "asked" when the email actually went out.
        // A transient workspace-quota-exceeded skip leaves the row so a later
        // pass retries; a genuine opt-out ('muted') is stamped (stop asking)
        // but mints no usable token. Without this, a suppressed send burned
        // the booking forever and the client was never actually asked.
        if (sendRes?.reason === 'workspace-quota-exceeded') {
          continue;
        }
        // A FAILED send ({ ok: false } - Resend threw / provider outage) must
        // also leave the row unstamped: stamping review_requested_at here
        // burned the booking permanently even though the client never got the
        // email. Leave it for the next run to retry.
        if (sendRes?.ok === false) {
          failed++;
          continue;
        }
        await sql`
          UPDATE bookings SET
            review_request_token_hash = ${sendRes?.sent ? hash : null},
            review_requested_at = NOW(),
            updated_at = NOW()
          WHERE id = ${r.id}
        `;
        if (sendRes?.sent) sent++;
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
