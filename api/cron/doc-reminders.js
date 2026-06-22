// /api/cron/doc-reminders - daily job that pings the owner about
// documents the client still hasn't signed.
//
// Trigger conditions per document:
//   - status = 'sent'
//   - sent_at is at least 3 days ago (give the client a fair window)
//   - last_overdue_reminder_at is NULL or older than 7 days
//
// Each surviving document gets:
//   - a push to the workspace owner ("X hasn't signed Y yet")
//   - a push to the client (gentle nudge - only if they've claimed
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
import { makeBrandingCache } from '../_lib/branding.js';
import { appUrl, generateRawToken } from '../_lib/tokens.js';
import crypto from 'node:crypto';
import { ok, serverError, unauthorized } from '../_lib/json.js';
import { ensureSchemaApplied } from '../_lib/ensureSchema.js';
import { trackCron } from '../_lib/cronMetrics.js';

const SEND_AFTER_HOURS  = 24 * 3;   // first nag at 3 days
const REPEAT_AFTER_HOURS = 24 * 7;  // then once a week
// Sized for ~100K active workspaces; sendEmail throttle (~8/sec) gates
// real throughput within the 300s cron budget.
const MAX_PER_RUN = 1000;

async function handler(req, res) {
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
    const getBranding = makeBrandingCache();
    for (const d of rows) {
      try {
        const days = Math.max(1, d.days_outstanding || 1);
        const recipient = d.recipient_name || 'A client';

        await notifyOwnerSafe({
          workspaceId: d.workspace_id,
          type: 'documents',
          payload: {
            title: 'Document still unsigned',
            body: `${recipient} hasn't signed "${d.name}" - ${days} day${days === 1 ? '' : 's'} now.`,
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

        // Email path. Mint a fresh sign link for the CURRENT pending
        // signer - for multi-signer docs that's whoever has status =
        // 'awaiting' in document_signers (not necessarily the original
        // recipient_email/name). For legacy single-signer docs there's
        // no document_signers row and we fall back to the documents
        // row. Without this branch, multi-signer reminders mint the
        // token in documents.sign_token_hash where no resolver looks
        // for it, so the email link 404s.
        let target = null;
        try {
          const sg = await sql`
            SELECT id, client_id, name, email
            FROM document_signers
            WHERE document_id = ${d.id} AND status = 'awaiting'
            ORDER BY order_index ASC
            LIMIT 1
          `;
          if (sg.rows[0]) {
            const r = sg.rows[0];
            target = { kind: 'signer', id: r.id, clientId: r.client_id, name: r.name, email: r.email };
          }
        } catch (e) {
          // document_signers absent on older deploys.
        }
        if (!target && d.recipient_email) {
          target = { kind: 'legacy', clientId: d.recipient_client_id, name: d.recipient_name, email: d.recipient_email };
        }
        if (target?.email) {
          try {
            const raw = generateRawToken(32);
            const hash = crypto.createHash('sha256').update(raw).digest('hex');
            if (target.kind === 'signer') {
              // Write the new token to the awaiting signer's row AND
              // keep the documents.sign_token_hash in sync so the
              // owner-side preview / legacy resolvers also see the
              // latest token (mirrors documents/resend.js behaviour).
              await sql`UPDATE document_signers SET sign_token_hash = ${hash}, updated_at = NOW() WHERE id = ${target.id}`;
              await sql`UPDATE documents SET sign_token_hash = ${hash}, updated_at = NOW() WHERE id = ${d.id}`;
            } else {
              await sql`UPDATE documents SET sign_token_hash = ${hash}, updated_at = NOW() WHERE id = ${d.id}`;
            }
            const branding = await getBranding(d.workspace_id);
            const link = `${appUrl()}/sign/${encodeURIComponent(raw)}`;
            await sendEmailToClient({
              clientId: target.clientId,
              type: 'documents',
              to: target.email,
              subject: `Reminder: please sign "${d.name}"`,
              replyTo: branding.replyTo,
              html: emailShell({
                heading: 'Document still waiting on you',
                body: `<p>Hi ${escapeHtml(target.name || 'there')},</p>
                  <p>This is a gentle nudge - <strong>${escapeHtml(d.name)}</strong> is still waiting on your signature. It's been ${days} day${days === 1 ? '' : 's'}.</p>
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

export default trackCron('doc-reminders', handler);
