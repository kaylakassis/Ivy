// /api/cron/invoice-overdue - daily cron that emails clients about
// invoices past their due_date. Mirrors the doc-reminders flow:
//   - status = 'sent'
//   - due_date is at least 1 day in the past
//   - last_overdue_reminder_at is NULL or older than 7 days
//
// Caps at MAX_PER_RUN to stay under Resend rate limits. Each invoice
// emailed gets `last_overdue_reminder_at = NOW()` so we don't spam.
//
// Schedule: daily 09:30 UTC (add to vercel.json crons[] list).
import crypto from 'node:crypto';
import { sql } from '../_lib/db.js';
import { reportError } from '../_lib/monitoring.js';
import { isSuperAdminBySession } from '../_lib/admin.js';
import { notifyClientSafe, notifyOwnerSafe } from '../_lib/push.js';
import { notifyInvoiceOverdue } from '../_lib/invoiceNotify.js';
import { generateRawToken, appUrl } from '../_lib/tokens.js';
import { ok, serverError, unauthorized } from '../_lib/json.js';
import { ensureSchemaApplied } from '../_lib/ensureSchema.js';
import { trackCron } from '../_lib/cronMetrics.js';

const REPEAT_AFTER_HOURS = 24 * 7;
// Sized for ~100K active workspaces; sendEmail throttle (~8/sec) gates
// real throughput within the 300s cron budget.
const MAX_PER_RUN = 1500;

async function handler(req, res) {
  const cronAuth = !!process.env.CRON_SECRET
    && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
  const adminAuth = process.env.ADMIN_SECRET
    && req.headers['x-admin-secret'] === process.env.ADMIN_SECRET;
  const userAuth = !cronAuth && !adminAuth ? await isSuperAdminBySession(req) : false;
  if (!cronAuth && !adminAuth && !userAuth) return unauthorized(res);

  try {
    await ensureSchemaApplied();

    // One-shot column add - idempotent.
    try {
      await sql`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS last_overdue_reminder_at TIMESTAMPTZ`;
    } catch {}

    const { rows } = await sql.query(
      `SELECT
         i.id, i.workspace_id, i.client_id, i.client_name, i.client_email,
         i.number, i.due_date,
         EXTRACT(DAY FROM NOW() - i.due_date::timestamp)::int AS days_overdue
       FROM invoices i
       WHERE i.status = 'sent'
         AND i.due_date IS NOT NULL
         AND i.due_date < CURRENT_DATE
         AND i.client_email IS NOT NULL
         AND (
           i.last_overdue_reminder_at IS NULL
           OR i.last_overdue_reminder_at <= NOW() - ($1 || ' hours')::interval
         )
       ORDER BY i.due_date ASC
       LIMIT ${MAX_PER_RUN}`,
      [String(REPEAT_AFTER_HOURS)],
    );

    let pinged = 0;
    for (const r of rows) {
      try {
        const days = Math.max(1, r.days_overdue || 1);
        // Mint a fresh view link so the email lands cleanly even if
        // the prior token was misplaced.
        const raw = generateRawToken(32);
        const hash = crypto.createHash('sha256').update(raw).digest('hex');
        await sql`UPDATE invoices SET view_token_hash = ${hash} WHERE id = ${r.id}`;
        const viewUrl = `${appUrl()}/invoice/${encodeURIComponent(raw)}`;
        await notifyInvoiceOverdue({
          workspaceId: r.workspace_id,
          invoiceId: r.id,
          daysOverdue: days,
          viewUrl,
        });
        if (r.client_id) {
          await notifyClientSafe({
            clientId: r.client_id,
            type: 'payments',
            payload: {
              title: 'Invoice overdue',
              body: `Invoice ${r.number} is ${days} day${days === 1 ? '' : 's'} past due.`,
              url: '/me/billing',
              tag: `inv-overdue-${r.id}`,
            },
          });
        }
        // Owner push so they know the chase is active without checking
        // Finance manually. Daily cadence is governed by the
        // last_overdue_reminder_at UPDATE below, so this won't spam.
        notifyOwnerSafe({
          workspaceId: r.workspace_id,
          type: 'payments',
          payload: {
            title: 'Invoice still unpaid',
            body: `${r.number} · ${r.client_name || 'client'} · ${days} day${days === 1 ? '' : 's'} overdue`,
            url: `/finance?invoice=${r.id}`,
            tag: `inv-overdue-owner-${r.id}`,
          },
        });
        await sql`
          UPDATE invoices SET last_overdue_reminder_at = NOW()
          WHERE id = ${r.id}
        `;
        pinged++;
      } catch (err) {
        console.warn('[invoice-overdue] failed for invoice', r.id, err.message);
        reportError(err, { extra: { invoiceId: r.id, workspaceId: r.workspace_id } });
      }
    }

    return ok(res, { ok: true, scanned: rows.length, pinged });
  } catch (err) {
    reportError(err, { req });
    return serverError(res, err);
  }
}

export default trackCron('invoice-overdue', handler);
