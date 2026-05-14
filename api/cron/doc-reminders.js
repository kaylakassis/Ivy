// /api/cron/doc-reminders — daily job that pings the owner about
// documents the client still hasn't signed.
//
// Trigger conditions per document:
//   - status = 'sent'
//   - sent_at is at least 3 days ago (give the client a fair window)
//   - last_overdue_reminder_at is NULL or older than 7 days
//
// Each surviving document gets:
//   - a push to the workspace owner ("X hasn't signed Y yet")
//   - a push to the client (gentle nudge — only if they've claimed
//     their portal account; otherwise silent)
// and stamps last_overdue_reminder_at = NOW() so we don't re-nag for
// another week.
//
// Auth mirrors welcome-emails: cron-secret OR admin-secret OR a signed-in
// super-admin clicking the in-app trigger.
import { sql } from '../_lib/db.js';
import { reportError } from '../_lib/monitoring.js';
import { isSuperAdminBySession } from '../_lib/admin.js';
import { notifyOwnerSafe, notifyClientSafe } from '../_lib/push.js';
import { sendEmailToClient, emailShell } from '../_lib/email.js';
import { fetchBranding } from '../_lib/branding.js';
import { appUrl, generateRawToken } from '../_lib/tokens.js';
import crypto from 'node:crypto';
import { ok, serverError, unauthorized } from '../_lib/json.js';
import { ensureSchemaApplied } from '../_lib/ensureSchema.js';

const SEND_AFTER_HOURS  = 24 * 3;   // first nag at 3 days
const REPEAT_AFTER_HOURS = 24 * 7;  // then once a week
const MAX_PER_RUN = 200;

export default async function handler(req, res) {
  const cronAuth = !!process.env.CRON_SECRET
    && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
  const adminAuth = process.env.ADMIN_SECRET
    && req.headers['x-admin-secret'] === process.env.ADMIN_SECRET;
  const userAuth = !cronAuth && !adminAuth ? await isSuperAdminBySession(req) : false;
  if (!cronAuth && !adminAuth && !userAuth) return unauthorized(res);

  try {
    await ensureSchemaApplied();
    const { rows } = await sql.query(
      `SELECT
         d.id, d.workspace_id, d.recipient_client_id, d.recipient_name,
         d.recipient_email, d.name, d.sent_at,
         EXTRACT(DAY FROM NOW() - d.sent_at)::int AS days_outstanding
       FROM documents d
       WHERE d.status = 'sent'
         AND d.sent_at IS NOT NULL
         AND d.sent_at <= NOW() - ($1 || ' hours')::interval
         AND (
           d.last_overdue_reminder_at IS NULL
           OR d.last_overdue_reminder_at <= NOW() - ($2 || ' hours')::interval
         )
       ORDER BY d.sent_at ASC
       LIMIT ${MAX_PER_RUN}`,
      [String(SEND_AFTER_HOURS), String(REPEAT_AFTER_HOURS)],
    );

    let pinged = 0;
    for (const d of rows) {
      try {
        const days = Math.max(1, d.days_outstanding || 1);
        const recipient = d.recipient_name || 'A client';

        await notifyOwnerSafe({
          workspaceId: d.workspace_id,
          type: 'documents',
          payload: {
            title: 'Document still unsigned',
            body: `${recipient} hasn't signed "${d.name}" — ${days} day${days === 1 ? '' : 's'} now.`,
            url: `/documents`,
            tag: `doc-overdue-${d.id}`,
          },
        });

        if (d.recipient_client_id) {
          await notifyClientSafe({
            clientId: d.recipient_client_id,
            type: 'documents',
            payload: {
              title: 'Reminder: document waiting for you',
              body: `Please sign "${d.name}" when you have a moment.`,
              url: `/me/documents`,
              tag: `doc-overdue-client-${d.id}`,
            },
          });
        }

        // Email path. Mint a fresh sign link (invalidates any older
        // link emailed previously; the most recent reminder always
        // works). Best-effort — failures here don't stop the cron.
        if (d.recipient_email) {
          try {
            const raw = generateRawToken(32);
            const hash = crypto.createHash('sha256').update(raw).digest('hex');
            await sql`UPDATE documents SET sign_token_hash = ${hash} WHERE id = ${d.id}`;
            const branding = await fetchBranding(d.workspace_id);
            const link = `${appUrl()}/sign/${encodeURIComponent(raw)}`;
            await sendEmailToClient({
              clientId: d.recipient_client_id,
              type: 'documents',
              to: d.recipient_email,
              subject: `Reminder: please sign "${d.name}"`,
              replyTo: branding.replyTo,
              html: emailShell({
                heading: 'Document still waiting on you',
                body: `<p>Hi ${escapeHtml(d.recipient_name || 'there')},</p>
                  <p>This is a gentle nudge — <strong>${escapeHtml(d.name)}</strong> is still waiting on your signature. It's been ${days} day${days === 1 ? '' : 's'}.</p>
                  <p>If you've already signed, you can ignore this.</p>`,
                ctaText: 'Open and sign',
                ctaUrl: link,
                footer: `If you weren't expecting this, you can safely ignore.`,
                branding,
              }),
            });
          } catch (mailErr) {
            console.warn('[doc-reminders] email failed for doc', d.id, mailErr.message);
          }
        }

        await sql`
          UPDATE documents SET last_overdue_reminder_at = NOW()
          WHERE id = ${d.id}
        `;
        pinged++;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[doc-reminders] failed for doc', d.id, err.message);
        reportError(err, { extra: { docId: d.id, workspaceId: d.workspace_id } });
      }
    }

    return ok(res, { ok: true, scanned: rows.length, pinged });
  } catch (err) {
    reportError(err, { req });
    return serverError(res, err);
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
