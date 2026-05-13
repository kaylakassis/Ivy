// /api/cron/recurring-invoices — daily at 08:00 UTC.
//
// Walks every recurring schedule whose next_run_at is on or before
// today and that's still 'active', mints a fresh invoice from the
// template, advances the schedule, and (if auto_send is on) emails
// the recipient + posts a thread message exactly like the manual
// /api/invoices/send path.
//
// Auth mirrors the other crons: cron-secret OR admin-secret OR a
// signed-in super-admin clicking the in-app trigger.
//
// Per-run cap of 200 to avoid runaway materialization on a misconfigured
// schedule. The cron is idempotent across runs because each successful
// materialization advances next_run_at past today.
import { sql } from '../_lib/db.js';
import { reportError } from '../_lib/monitoring.js';
import { isSuperAdminBySession } from '../_lib/admin.js';
import { materializeOne } from '../_lib/recurring.js';
import { computeTotals } from '../_lib/finance.js';
import { generateRawToken, appUrl } from '../_lib/tokens.js';
import { sendEmail, emailShell } from '../_lib/email.js';
import { fetchBranding } from '../_lib/branding.js';
import { ok, serverError, unauthorized } from '../_lib/json.js';
import { ensureSchemaApplied } from '../_lib/ensureSchema.js';
import crypto from 'node:crypto';

const MAX_PER_RUN = 200;

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtMoney(n) { return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

export default async function handler(req, res) {
  const cronAuth = !!process.env.CRON_SECRET
    && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
  const adminAuth = process.env.ADMIN_SECRET
    && req.headers['x-admin-secret'] === process.env.ADMIN_SECRET;
  const userAuth = !cronAuth && !adminAuth ? await isSuperAdminBySession(req) : false;
  if (!cronAuth && !adminAuth && !userAuth) return unauthorized(res);

  try {
    await ensureSchemaApplied();
    const due = await sql`
      SELECT id FROM recurring_invoices
       WHERE status = 'active'
         AND next_run_at <= CURRENT_DATE
       ORDER BY next_run_at ASC
       LIMIT ${MAX_PER_RUN}
    `;
    let materialized = 0;
    let sent = 0;
    let errors = 0;

    for (const r of due.rows) {
      try {
        const result = await materializeOne(r.id);
        if (result.skipped) continue;
        materialized++;

        const { schedule, invoice } = result;
        if (!schedule.auto_send) continue;
        // Auto-send: skip if no email on file. Unsent invoices stay
        // 'draft' so the owner can review + send manually.
        if (!schedule.client_email) continue;
        try {
          await autoSendInvoice({ schedule, invoice });
          sent++;
        } catch (sendErr) {
          // eslint-disable-next-line no-console
          console.error('[cron/recurring] send failed:', sendErr.message);
          errors++;
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[cron/recurring] materialize failed:', err.message);
        errors++;
        try { reportError(err); } catch { /* ignore */ }
      }
    }

    return ok(res, {
      considered: due.rows.length,
      materialized,
      sent,
      errors,
    });
  } catch (err) {
    return serverError(res, err);
  }
}

// Mirror of /api/invoices/send.js but called server-side. Stamps a
// view token on the invoice, emails the client, drops a thread
// message — same flow the owner would trigger by hand.
async function autoSendInvoice({ schedule, invoice }) {
  if (!invoice.client_email) return;
  const rawToken = generateRawToken(32);
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const totals = computeTotals(invoice.items, invoice.tax_rate, invoice.discount);
  const newActivity = [
    ...(invoice.activity || []),
    { ts: new Date().toISOString(), kind: 'sent', text: `Auto-sent (recurring): ${schedule.name}` },
  ];
  await sql`
    UPDATE invoices SET
      view_token_hash = ${tokenHash},
      status = 'sent',
      sent_at = NOW(),
      activity = ${JSON.stringify(newActivity)}::jsonb,
      updated_at = NOW()
    WHERE id = ${invoice.id}
  `;
  const link = `${appUrl()}/invoice/${encodeURIComponent(rawToken)}`;
  const branding = await fetchBranding(invoice.workspace_id);
  const business = branding.businessName;
  await sendEmail({
    to: invoice.client_email,
    subject: `Invoice ${invoice.number}${business ? ' from ' + business : ''} · ${fmtMoney(totals.total)}`,
    replyTo: branding.replyTo,
    html: emailShell({
      heading: `Invoice ${invoice.number}`,
      body: `<p>Hi ${escapeHtml(invoice.client_name)},</p>
             <p>This is your recurring invoice for <b>${fmtMoney(totals.total)}</b>${invoice.due_date ? ', due ' + escapeHtml(new Date(invoice.due_date).toLocaleDateString()) : ''}.</p>
             <p>Open the invoice to review the line items.</p>`,
      ctaText: 'View invoice',
      ctaUrl: link,
      footer: `Reply to this email if anything looks off.`,
      branding,
    }),
  });
  // Best-effort thread message.
  try {
    if (invoice.client_id) {
      const t = await sql`
        INSERT INTO message_threads (workspace_id, client_id)
        VALUES (${invoice.workspace_id}, ${invoice.client_id})
        ON CONFLICT (workspace_id, client_id) DO UPDATE SET workspace_id = EXCLUDED.workspace_id
        RETURNING id
      `;
      const threadId = t.rows[0].id;
      const meta = { invoiceId: invoice.id, number: invoice.number, total: totals.total, recurring: true };
      const text = `Recurring invoice ${invoice.number} sent · ${fmtMoney(totals.total)}`;
      await sql`
        INSERT INTO messages (thread_id, sender, text, kind, meta)
        VALUES (${threadId}, 'system', ${text}, 'invoice-sent', ${JSON.stringify(meta)}::jsonb)
      `;
      await sql`
        UPDATE message_threads SET
          last_message_at = NOW(),
          last_message_preview = ${text},
          unread_client = unread_client + 1
        WHERE id = ${threadId}
      `;
    }
  } catch (msgErr) {
    // eslint-disable-next-line no-console
    console.error('[cron/recurring] thread message failed:', msgErr.message);
  }
}
