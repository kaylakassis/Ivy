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
import { shardFromReq, shardClause, withDeadline, terminationReason } from '../_lib/cronShard.js';

const REPEAT_AFTER_HOURS = 24 * 7;
// Per-batch fetch. Each row = 1 email + push + 1 stamp UPDATE. 250
// keeps the deadline check responsive without thrashing the candidate
// query. The stamp UPDATE excludes the row from the next batch, so the
// loop drains the candidate set cleanly.
const BATCH_SIZE = 250;

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

    // Flip 'sent' → 'overdue' once the due date passes (and back, when an
    // owner extends a due date). This status was previously never WRITTEN
    // anywhere, leaving the Finance overdue KPI, the Overdue filter, and
    // Ivy's overdue-invoice queries permanently empty. Idempotent; runs
    // before the reminder loop so reminders and status agree.
    await sql`
      UPDATE invoices i SET status = 'overdue', updated_at = NOW()
       WHERE i.status = 'sent'
         AND i.due_date IS NOT NULL
         AND i.due_date < (NOW() AT TIME ZONE COALESCE(
               (SELECT cs.timezone FROM calendar_settings cs WHERE cs.workspace_id = i.workspace_id),
               'UTC'))::date
    `;
    await sql`
      UPDATE invoices i SET status = 'sent', updated_at = NOW()
       WHERE i.status = 'overdue'
         AND (i.due_date IS NULL OR i.due_date >= (NOW() AT TIME ZONE COALESCE(
               (SELECT cs.timezone FROM calendar_settings cs WHERE cs.workspace_id = i.workspace_id),
               'UTC'))::date)
    `;

    const { shard, shards } = shardFromReq(req);
    const shardFilter = shardClause({ shard, shards }, 'i.workspace_id');

    let scanned = 0, pinged = 0, batches = 0;
    let emptied = false;

    await withDeadline(async (deadline) => {
      while (Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop
        const { rows } = await sql.query(
          `SELECT
             i.id, i.workspace_id, i.client_id, i.client_name, i.client_email,
             i.number, i.due_date,
             EXTRACT(DAY FROM NOW() - i.due_date::timestamp)::int AS days_overdue
           FROM invoices i
           LEFT JOIN calendar_settings cs ON cs.workspace_id = i.workspace_id
           WHERE i.status IN ('sent', 'overdue')
             AND i.due_date IS NOT NULL
             AND i.due_date < (NOW() AT TIME ZONE COALESCE(cs.timezone, 'UTC'))::date
             AND i.client_email IS NOT NULL
             AND (
               i.last_overdue_reminder_at IS NULL
               OR i.last_overdue_reminder_at <= NOW() - ($1 || ' hours')::interval
             )
             ${shardFilter}
           ORDER BY i.due_date ASC
           LIMIT ${BATCH_SIZE}`,
          [String(REPEAT_AFTER_HOURS)],
        );
        if (rows.length === 0) { emptied = true; break; }
        scanned += rows.length;
        batches += 1;
        for (const r of rows) {
          try {
            const days = Math.max(1, r.days_overdue || 1);
            // Mint a fresh view link so the email lands cleanly even if
            // the prior token was misplaced.
            const raw = generateRawToken(32);
            const hash = crypto.createHash('sha256').update(raw).digest('hex');
            // Status guard: if a payment landed between the candidate
            // SELECT and here, skip - don't re-mint a token and email
            // "overdue" about a just-paid invoice.
            // eslint-disable-next-line no-await-in-loop
            const minted = await sql`
              UPDATE invoices SET view_token_hash = ${hash}
               WHERE id = ${r.id} AND status IN ('sent', 'overdue')
               RETURNING id
            `;
            if (minted.rows.length === 0) continue;
            const viewUrl = `${appUrl()}/invoice/${encodeURIComponent(raw)}`;
            // eslint-disable-next-line no-await-in-loop
            await notifyInvoiceOverdue({
              workspaceId: r.workspace_id,
              invoiceId: r.id,
              daysOverdue: days,
              viewUrl,
            });
            if (r.client_id) {
              // eslint-disable-next-line no-await-in-loop
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
            // Stamp AFTER the sends so a mid-batch failure doesn't mute
            // the row for a week — it'll be re-attempted on the next
            // cron tick.
            // eslint-disable-next-line no-await-in-loop
            await sql`
              UPDATE invoices SET last_overdue_reminder_at = NOW()
              WHERE id = ${r.id}
            `;
            pinged++;
          } catch (err) {
            console.warn('[invoice-overdue] failed for invoice', r.id, err.message);
            reportError(err, { extra: { invoiceId: r.id, workspaceId: r.workspace_id } });
          }
          if (Date.now() >= deadline) break;
        }
      }
    });

    const terminatedBy = terminationReason({ emptied, hitCap: false });
    return ok(res, { ok: true, shard, shards, batches, scanned, pinged, terminatedBy });
  } catch (err) {
    reportError(err, { req });
    return serverError(res, err);
  }
}

export default trackCron('invoice-overdue', handler);
