// /api/cron/invoice-due-soon - daily cron that gives clients a friendly
// heads-up a few days BEFORE an invoice's due_date. The proactive
// counterpart to invoice-overdue:
//   - status = 'sent'
//   - due_date is between today and DUE_SOON_DAYS days out (still future)
//   - due_soon_reminder_sent_at IS NULL (one nudge per invoice, ever)
//
// Caps at MAX_PER_RUN to stay under Resend rate limits. Each invoice
// emailed gets `due_soon_reminder_sent_at = NOW()` so it never re-fires;
// once it crosses due_date the separate invoice-overdue cron takes over.
//
// Schedule: daily 13:00 UTC (see vercel.json crons[]).
import crypto from 'node:crypto';
import { sql } from '../_lib/db.js';
import { reportError } from '../_lib/monitoring.js';
import { isSuperAdminBySession } from '../_lib/admin.js';
import { notifyClientSafe } from '../_lib/push.js';
import { notifyInvoiceDueSoon } from '../_lib/invoiceNotify.js';
import { generateRawToken, appUrl } from '../_lib/tokens.js';
import { ok, serverError, unauthorized } from '../_lib/json.js';
import { ensureSchemaApplied } from '../_lib/ensureSchema.js';
import { trackCron } from '../_lib/cronMetrics.js';
import { shardFromReq, shardClause, withDeadline } from '../_lib/cronShard.js';

// How many days before due_date the heads-up goes out.
const DUE_SOON_DAYS = 3;
// Per-batch fetch. The due_soon_reminder_sent_at UPDATE excludes the row
// from the next batch so the loop drains naturally.
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
      await sql`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS due_soon_reminder_sent_at TIMESTAMPTZ`;
    } catch {}

    const { shard, shards } = shardFromReq(req);
    const shardFilter = shardClause({ shard, shards }, 'i.workspace_id');

    let scanned = 0, pinged = 0, batches = 0;

    await withDeadline(async (deadline) => {
      while (Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop
        const { rows } = await sql.query(
          `SELECT
             i.id, i.workspace_id, i.client_id, i.client_name, i.client_email,
             i.number, i.due_date,
             GREATEST(0, EXTRACT(DAY FROM i.due_date::timestamp - NOW())::int) AS days_until_due
           FROM invoices i
           WHERE i.status = 'sent'
             AND i.due_date IS NOT NULL
             AND i.due_date >= CURRENT_DATE
             AND i.due_date <= CURRENT_DATE + ($1::int)
             AND i.client_email IS NOT NULL
             AND i.due_soon_reminder_sent_at IS NULL
             ${shardFilter}
           ORDER BY i.due_date ASC
           LIMIT ${BATCH_SIZE}`,
          [DUE_SOON_DAYS],
        );
        if (rows.length === 0) break;
        scanned += rows.length;
        batches += 1;
        for (const r of rows) {
          try {
            const raw = generateRawToken(32);
            const hash = crypto.createHash('sha256').update(raw).digest('hex');
            // eslint-disable-next-line no-await-in-loop
            await sql`UPDATE invoices SET view_token_hash = ${hash} WHERE id = ${r.id}`;
            const viewUrl = `${appUrl()}/invoice/${encodeURIComponent(raw)}`;
            // eslint-disable-next-line no-await-in-loop
            await notifyInvoiceDueSoon({
              workspaceId: r.workspace_id,
              invoiceId: r.id,
              daysUntilDue: r.days_until_due,
              viewUrl,
            });
            if (r.client_id) {
              // eslint-disable-next-line no-await-in-loop
              await notifyClientSafe({
                clientId: r.client_id,
                type: 'payments',
                payload: {
                  title: 'Invoice due soon',
                  body: `Invoice ${r.number} is due in ${r.days_until_due} day${r.days_until_due === 1 ? '' : 's'}.`,
                  url: '/me/billing',
                  tag: `inv-due-soon-${r.id}`,
                },
              });
            }
            // eslint-disable-next-line no-await-in-loop
            await sql`UPDATE invoices SET due_soon_reminder_sent_at = NOW() WHERE id = ${r.id}`;
            pinged++;
          } catch (err) {
            console.warn('[invoice-due-soon] failed for invoice', r.id, err.message);
            reportError(err, { extra: { invoiceId: r.id, workspaceId: r.workspace_id } });
          }
          if (Date.now() >= deadline) break;
        }
      }
    });

    return ok(res, { ok: true, shard, shards, batches, scanned, pinged });
  } catch (err) {
    reportError(err, { req });
    return serverError(res, err);
  }
}

export default trackCron('invoice-due-soon', handler);
