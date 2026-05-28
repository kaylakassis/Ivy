// Daily group-chat digest. Sends each user a single email summarizing
// every active group_thread_member row with unread_count > 0 across
// every workspace they're a client of. Skips users who disabled
// digest_groups_daily.
//
// Runs at 08:30 UTC daily (just after morning standup time on the
// US east coast). Idempotent: stamps users.digest_last_sent_at so a
// re-run in the same calendar day is a no-op.
import { sql } from '../_lib/db.js';
import { isSuperAdminBySession } from '../_lib/admin.js';
import { sendEmailToUser, emailShell } from '../_lib/email.js';
import { fetchBranding } from '../_lib/branding.js';
import { appUrl } from '../_lib/tokens.js';
import { trackCron } from '../_lib/cronMetrics.js';
import { ok, serverError, unauthorized } from '../_lib/json.js';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function handler(req, res) {
  const cronAuth = !!process.env.CRON_SECRET
    && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
  const adminAuth = process.env.ADMIN_SECRET
    && req.headers['x-admin-secret'] === process.env.ADMIN_SECRET;
  const userAuth = !cronAuth && !adminAuth ? await isSuperAdminBySession(req) : false;
  if (!cronAuth && !adminAuth && !userAuth) return unauthorized(res);

  try {
    // Find candidate users: those with at least one unread group as a
    // client member, opted-in, and not already sent in the last 23h
    // (so a re-run during the same window doesn't re-send).
    const { rows: users } = await sql`
      SELECT DISTINCT u.id, u.email, u.name
        FROM users u
        JOIN clients c ON c.user_id = u.id
        JOIN group_thread_members m
          ON m.client_id = c.id AND m.workspace_id = c.workspace_id
        JOIN group_threads t
          ON t.id = m.thread_id AND t.workspace_id = m.workspace_id
       WHERE u.digest_groups_daily = TRUE
         AND m.left_at IS NULL
         AND m.unread_count > 0
         AND t.archived = FALSE
         AND (u.digest_last_sent_at IS NULL OR u.digest_last_sent_at < NOW() - INTERVAL '23 hours')
       LIMIT 5000
    `;

    let sent = 0, failed = 0;
    for (const u of users) {
      try {
        const { rows: items } = await sql.query(
          `SELECT t.id AS thread_id, t.name AS group_name,
                  m.unread_count, t.last_message_preview,
                  cs.biz_name, w.name AS workspace_name, w.id AS workspace_id
             FROM group_thread_members m
             JOIN clients c ON c.id = m.client_id AND c.workspace_id = m.workspace_id
             JOIN group_threads t ON t.id = m.thread_id AND t.workspace_id = m.workspace_id
             JOIN workspaces w ON w.id = t.workspace_id
             LEFT JOIN calendar_settings cs ON cs.workspace_id = t.workspace_id
            WHERE c.user_id = $1
              AND m.left_at IS NULL
              AND m.unread_count > 0
              AND t.archived = FALSE
            ORDER BY m.unread_count DESC LIMIT 20`,
          [u.id],
        );
        if (items.length === 0) continue;
        const totalUnread = items.reduce((n, x) => n + Number(x.unread_count || 0), 0);

        // Group items by business so the email is scannable.
        const byBiz = new Map();
        for (const it of items) {
          const biz = it.biz_name || it.workspace_name || 'Business';
          if (!byBiz.has(biz)) byBiz.set(biz, []);
          byBiz.get(biz).push(it);
        }

        const sectionHtml = Array.from(byBiz.entries()).map(([biz, list]) => `
          <div style="margin:18px 0;">
            <div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#7B7867;font-weight:600;margin-bottom:8px">${escapeHtml(biz)}</div>
            ${list.map((it) => `
              <div style="padding:10px 12px;border:1px solid #E6E2D6;border-radius:8px;margin-bottom:6px;font-size:14px">
                <strong>${escapeHtml(it.group_name)}</strong>
                <span style="color:#7B7867;font-weight:500"> · ${it.unread_count} new</span>
                ${it.last_message_preview ? `<div style="color:#5A5650;margin-top:4px;font-size:13px">${escapeHtml(it.last_message_preview).slice(0, 200)}</div>` : ''}
              </div>`).join('')}
          </div>`).join('');

        const branding = await fetchBranding(null).catch(() => ({}));
        await sendEmailToUser({
          userId: u.id, type: 'messages',
          to: u.email,
          subject: `${totalUnread} new group message${totalUnread === 1 ? '' : 's'}`,
          html: emailShell({
            heading: 'Your daily group recap',
            body: `<p>You have ${totalUnread} unread message${totalUnread === 1 ? '' : 's'} across your groups.</p>${sectionHtml}`,
            ctaText: 'Open my groups',
            ctaUrl: `${appUrl()}/me/messages`,
            footer: 'You can turn off this daily digest in your account settings.',
            branding,
          }),
        });
        await sql`UPDATE users SET digest_last_sent_at = NOW() WHERE id = ${u.id}`;
        sent++;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[group-digest] failed for', u.id, err.message);
        failed++;
      }
    }
    return ok(res, { candidates: users.length, sent, failed });
  } catch (err) {
    return serverError(res, err);
  }
}

export default trackCron('group-digest', handler);
