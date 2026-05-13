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
         d.name, d.sent_at,
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
