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
import { cronAuthorized } from '../_lib/cronAuth.js';
import { notifyClientSafe } from '../_lib/push.js';
import { notifyInvoiceDueSoon, reminderOwed } from '../_lib/invoiceNotify.js';
import { generateRawToken, appUrl } from '../_lib/tokens.js';
import { ok, serverError, unauthorized } from '../_lib/json.js';
import { ensureSchemaApplied } from '../_lib/ensureSchema.js';
import { trackCron } from '../_lib/cronMetrics.js';
import { shardFromReq, shardClause, withDeadline, terminationReason } from '../_lib/cronShard.js';

// How many days before due_date the heads-up goes out.
const DUE_SOON_DAYS = 3;
// Per-batch fetch. The due_soon_reminder_sent_at UPDATE excludes the row
// from the next batch so the loop drains naturally.
const BATCH_SIZE = 250;

async function handler(req, res) {
  if (!(await cronAuthorized(req))) return unauthorized(res);

  try {
    await ensureSchemaApplied();

    // One-shot column add - idempotent.
    try {
      await sql`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS due_soon_reminder_sent_at TIMESTAMPTZ`;
    } catch {}

    const { shard, shards } = shardFromReq(req);
    const shardFilter = shardClause({ shard, shards }, 'i.workspace_id');

    let scanned = 0, pinged = 0, batches = 0;
    let emptied = false;

    await withDeadline(async (deadline) => {
      while (Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop
        const { rows } = await sql.query(
          `SELECT
             i.*,
             GREATEST(0, EXTRACT(DAY FROM i.due_date::timestamp - NOW())::int) AS days_until_due
           FROM invoices i
           LEFT JOIN calendar_settings cs ON cs.workspace_id = i.workspace_id
           WHERE i.status = 'sent'
             AND i.payment_processing_at IS NULL
             AND i.archived_at IS NULL
             AND i.due_date IS NOT NULL
             AND i.due_date >= (NOW() AT TIME ZONE COALESCE(cs.timezone, 'UTC'))::date
             AND i.due_date <= (NOW() AT TIME ZONE COALESCE(cs.timezone, 'UTC'))::date + ($1::int)
             AND i.client_email IS NOT NULL
             AND i.due_soon_reminder_sent_at IS NULL
             ${shardFilter}
           ORDER BY i.due_date ASC
           LIMIT ${BATCH_SIZE}`,
          [DUE_SOON_DAYS],
        );
        if (rows.length === 0) { emptied = true; break; }
        scanned += rows.length;
        batches += 1;
        for (const r of rows) {
          let claimed = false;
          try {
            if (reminderOwed(r) <= 0) {
              // eslint-disable-next-line no-await-in-loop
              await sql`UPDATE invoices SET due_soon_reminder_sent_at = NOW() WHERE id = ${r.id}`;
              continue;
            }
            const raw = generateRawToken(32);
            const hash = crypto.createHash('sha256').update(raw).digest('hex');
            // Status guard: an invoice voided or paid since the SELECT keeps
            // its state - never re-open a pay link on it or remind about it.
            // Claim: the same UPDATE stamps the reminder, gated on it not
            // being sent yet, so when two runs overlap (a cron event
            // delivered twice, or a manual run) only one emails the client.
            // eslint-disable-next-line no-await-in-loop
            const minted = await sql`
              UPDATE invoices SET view_token_hash = ${hash}, due_soon_reminder_sent_at = NOW()
               WHERE id = ${r.id} AND status = 'sent' AND payment_processing_at IS NULL
                 AND due_soon_reminder_sent_at IS NULL
               RETURNING id`;
            if (minted.rows.length === 0) continue;
            claimed = true;
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
                  url: '/me/invoices',
                  tag: `inv-due-soon-${r.id}`,
                },
              });
            }
            pinged++;
          } catch (err) {
            // A failure after the claim hands the row back for a later run.
            if (claimed) {
              // eslint-disable-next-line no-await-in-loop
              await sql`UPDATE invoices SET due_soon_reminder_sent_at = NULL WHERE id = ${r.id}`.catch(() => {});
            }
            console.warn('[invoice-due-soon] failed for invoice', r.id, err.message);
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

export default trackCron('invoice-due-soon', handler);
