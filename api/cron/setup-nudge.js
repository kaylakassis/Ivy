// Out-of-app setup-completion nudge. An owner can finish the onboarding wizard
// (onboarded_at set) yet leave a REQUIRED setup item open — no service, no
// availability, unverified email — which leaves their booking page unable to
// take a booking. Today that's only surfaced by the in-app SetupChecklist, so
// an owner who wanders off is unreachable. This cron emails/pushes them once,
// naming the single most important gap, a couple of days after they onboarded.
//
// One-shot via workspaces.setup_nudge_sent_at; only recent signups (≤30 days)
// are scanned so the daily scan stays bounded. Auth: same three paths as the
// other crons. Registered in vercel.json.
import { sql } from '../_lib/db.js';
import { isSuperAdminBySession } from '../_lib/admin.js';
import { sendEmailToUser, emailShell } from '../_lib/email.js';
import { notifyOwnerSafe } from '../_lib/push.js';
import { appUrl } from '../_lib/tokens.js';
import { trackCron } from '../_lib/cronMetrics.js';
import { ok, serverError, unauthorized } from '../_lib/json.js';

const MAX_PER_RUN = 200;

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Priority order matches the in-app checklist: the earliest missing REQUIRED
// item is the one we name. Returns { id, label, href } or null when complete.
function firstMissing(r) {
  const hasAvailability = r.availability && typeof r.availability === 'object'
    && Object.values(r.availability).some((v) => Array.isArray(v) && v.length > 0);
  if (!r.email_verified_at) return { id: 'email', label: 'confirm your email address', href: '/account' };
  if (!(r.biz_name && String(r.biz_name).trim())) return { id: 'biz', label: 'name your business', href: '/calendar' };
  if (!(r.slug && String(r.slug).trim())) return { id: 'slug', label: 'pick your booking link', href: '/calendar' };
  if (!Number(r.svc_count)) return { id: 'service', label: 'add your first service', href: '/calendar' };
  if (!hasAvailability) return { id: 'availability', label: 'set your weekly availability', href: '/calendar' };
  return null;
}

async function handler(req, res) {
  const cronAuth = !!process.env.CRON_SECRET
    && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
  const adminAuth = process.env.ADMIN_SECRET
    && req.headers['x-admin-secret'] === process.env.ADMIN_SECRET;
  const userAuth = !cronAuth && !adminAuth ? await isSuperAdminBySession(req) : false;
  if (!cronAuth && !adminAuth && !userAuth) return unauthorized(res);

  try {
    const { rows } = await sql.query(
      `SELECT w.id AS workspace_id, w.owner_id, u.email, u.name, u.email_verified_at,
              cs.biz_name, cs.slug, cs.availability,
              (SELECT COUNT(*)::int FROM services s WHERE s.workspace_id = w.id) AS svc_count
         FROM workspaces w
         JOIN users u ON u.id = w.owner_id
         LEFT JOIN calendar_settings cs ON cs.workspace_id = w.id
        WHERE w.subscription_status IN ('trialing', 'active')
          AND w.onboarded_at IS NOT NULL
          AND w.onboarded_at < NOW() - INTERVAL '2 days'
          AND w.onboarded_at > NOW() - INTERVAL '30 days'
          AND w.setup_nudge_sent_at IS NULL
          AND u.email IS NOT NULL
          AND COALESCE(u.user_type, 'regular') <> 'sponsored'
        ORDER BY w.onboarded_at ASC
        LIMIT $1`,
      [MAX_PER_RUN],
    );

    let sent = 0;
    for (const r of rows) {
      const miss = firstMissing(r);
      if (!miss) continue; // required setup already complete — leave for a later scan
      // Stamp under the guard first so a retry / concurrent run can't double-send.
      // eslint-disable-next-line no-await-in-loop
      const upd = await sql.query(
        `UPDATE workspaces SET setup_nudge_sent_at = NOW()
           WHERE id = $1 AND setup_nudge_sent_at IS NULL RETURNING id`,
        [r.workspace_id],
      );
      if (upd.rows.length === 0) continue;
      sent++;

      const fn = escapeHtml((r.name || '').split(/\s+/)[0] || 'there');
      const html = emailShell({
        heading: "You're one step from taking bookings",
        body: `<p>Hi ${fn},</p>
          <p>Your Ivy OS account is set up, but there's one thing left before your
          booking page can take a booking: <strong>${escapeHtml(miss.label)}</strong>.</p>
          <p>It takes about a minute, and Ivy can help you do it.</p>`,
        ctaText: 'Finish setup',
        ctaUrl: `${appUrl()}${miss.href}`,
        footer: 'Manage email preferences from Account → Notifications.',
      });
      // eslint-disable-next-line no-await-in-loop
      await sendEmailToUser({ userId: r.owner_id, type: 'reports', to: r.email, subject: "One step left to start taking bookings", html })
        .catch((e) => console.error('[setup-nudge] email failed:', r.workspace_id, e?.message));
      notifyOwnerSafe({
        workspaceId: r.workspace_id,
        payload: { title: 'One step left to take bookings', body: `Finish: ${miss.label}.`, url: miss.href, tag: 'setup-nudge' },
      });
    }
    return ok(res, { scanned: rows.length, sent });
  } catch (err) {
    return serverError(res, err);
  }
}

export default trackCron('setup-nudge', handler);
