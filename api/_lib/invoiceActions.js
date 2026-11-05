// Shared cores for the owner's invoice clean-up actions: void, delete and
// archive. The HTTP routes (api/invoices/void.js, [id].js DELETE,
// archive.js) and Ivy's approval-gated tools call these, so the rules in
// src/lib/invoiceRules.js are enforced in exactly one place on the server.
//
// Every function is scoped to workspaceId and throws an Error whose
// message is safe to show the owner (err.code = 'not_found' | 'refused').
// Each write re-checks its guard inside the UPDATE / DELETE so a payment
// landing between the read and the write always wins.
import { sql } from './db.js';
import { fetchOwnedInvoice, serializeInvoice } from './finance.js';
import { restoreStock } from './products.js';
import { restoreGiftCardCreditForInvoice } from './giftCards.js';
import { recordWorkspaceAudit } from './audit.js';
import { invoiceActions } from '../../src/lib/invoiceRules.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function refused(message) {
  return Object.assign(new Error(message), { code: 'refused' });
}
function notFound() {
  return Object.assign(new Error('Invoice not found'), { code: 'not_found' });
}

async function load(workspaceId, id) {
  if (!id || !UUID_RE.test(String(id))) throw notFound();
  const inv = await fetchOwnedInvoice({ id: String(id), workspaceId });
  if (!inv) throw notFound();
  return inv;
}

// Void an unpaid invoice. It stays on record marked Void; the client's link
// shows "This invoice was voided" and can no longer take a payment; no
// reminders go out; any gift card credit goes back on the card and POS
// stock goes back on the shelf. Optionally emails the client.
export async function voidInvoiceCore({ workspaceId, id, actor = null, req = null, notifyClient = false }) {
  const inv = await load(workspaceId, id);
  const rule = invoiceActions(inv).void;
  if (!rule.ok) throw refused(rule.why);

  // POS sales decrement stock at pay-link issuance, so voiding an unpaid
  // sale puts the units back. Balanced pairs ('restocked' vs
  // 'stock-rededucted' from restore) make a void, restore, void cycle
  // restock exactly once per void.
  const activity = inv.activity || [];
  const stockItems = (Array.isArray(inv.items) ? inv.items : [])
    .filter((it) => it.productId && Number(it.quantity) > 0);
  const restocks  = activity.filter((a) => a.kind === 'restocked').length;
  const rededucts = activity.filter((a) => a.kind === 'stock-rededucted').length;
  const willRestock = stockItems.length > 0 && restocks <= rededucts;

  const giftCreditLeft = Number(inv.gift_card_credit_cents || 0) - Number(inv.gift_card_credit_restored_cents || 0);
  const now = new Date().toISOString();
  const newActivity = [
    ...activity,
    { ts: now, kind: 'voided', text: 'Invoice voided. Nothing is owed.' },
    ...(giftCreditLeft > 0
      ? [{ ts: now, kind: 'gift-card-restored',
          text: `Gift card credit of $${(giftCreditLeft / 100).toFixed(2)} returned to the card ending ${inv.gift_card_code_last4 || '????'}` }]
      : []),
    ...(willRestock ? [{ ts: now, kind: 'restocked', text: 'Stock returned to inventory' }] : []),
  ];

  // The view token is kept on purpose: the client's link now shows
  // "This invoice was voided" (read only) instead of a dead page. Paying,
  // claiming and gift cards all require 'sent' / 'overdue', so a void
  // invoice can never take money.
  const updated = await sql`
    UPDATE invoices SET
      status = 'voided',
      activity = ${JSON.stringify(newActivity)}::jsonb,
      updated_at = NOW()
    WHERE id = ${inv.id} AND workspace_id = ${workspaceId}
      AND status IN ('draft', 'sent', 'overdue')
      AND payment_processing_at IS NULL
      AND COALESCE(paid_amount, 0) - COALESCE(refunded_amount, 0) <= 0
    RETURNING *
  `;
  if (updated.rows.length === 0) {
    throw refused('This invoice just changed (a payment may have landed). Refresh to see where it stands.');
  }
  if (giftCreditLeft > 0) {
    await restoreGiftCardCreditForInvoice({ workspaceId, invoiceId: inv.id })
      .catch((err) => console.error('[invoice void] gift card restore failed:', err.message));
  }
  if (willRestock) {
    for (const it of stockItems) {
      // eslint-disable-next-line no-await-in-loop
      await restoreStock({ workspaceId, productId: it.productId, qty: it.quantity });
    }
  }
  recordWorkspaceAudit(req, {
    workspaceId, actor,
    action: 'invoice.void',
    target: { kind: 'invoice', id: inv.id },
    meta: { number: inv.number, client_name: inv.client_name, notify_client: !!notifyClient },
  });

  let clientNotified = false;
  if (notifyClient && inv.sent_at && inv.client_email) {
    const { notifyInvoiceVoided } = await import('./invoiceNotify.js');
    const r = await notifyInvoiceVoided({ workspaceId, invoiceId: inv.id }).catch(() => ({ sent: false }));
    clientNotified = !!r?.sent;
  }
  const finalRow = giftCreditLeft > 0 ? (await fetchOwnedInvoice({ id: inv.id, workspaceId })) || updated.rows[0] : updated.rows[0];
  return { invoice: serializeInvoice(finalRow), clientNotified };
}

// Delete an invoice for good. Only a draft (or a void draft) that was never
// sent and has no payment or gift card on it. Anything a client has seen,
// or where money moved, stays on record: void or archive it instead.
export async function deleteInvoiceCore({ workspaceId, id, actor = null, req = null }) {
  const inv = await load(workspaceId, id);
  const rule = invoiceActions(inv).delete;
  if (!rule.ok) throw refused(rule.why);
  // Time billed onto this draft goes back to "ready to bill".
  await sql`
    UPDATE time_entries SET status = 'stopped', invoice_id = NULL, updated_at = NOW()
     WHERE invoice_id = ${inv.id} AND workspace_id = ${workspaceId} AND status = 'billed'
  `.catch((err) => console.warn('[invoice delete] time entries not released:', err.message));
  const del = await sql`
    DELETE FROM invoices
     WHERE id = ${inv.id} AND workspace_id = ${workspaceId}
       AND status IN ('draft', 'voided')
       AND sent_at IS NULL
       AND COALESCE(paid_amount, 0) = 0
       AND gift_card_credit_cents - gift_card_credit_restored_cents <= 0
     RETURNING id
  `;
  if (del.rows.length === 0) {
    throw refused('This invoice just changed. Refresh to see where it stands.');
  }
  recordWorkspaceAudit(req, {
    workspaceId, actor,
    action: 'invoice.delete',
    target: { kind: 'invoice', id: inv.id },
    meta: { number: inv.number, client_name: inv.client_name, status: inv.status },
  });
  return { deleted: true, id: inv.id, number: inv.number };
}

export const ARCHIVE_MAX = 200;

// Archive (hide) or unarchive settled invoices: paid, refunded or void.
// Archiving changes nothing else: payments, refunds, revenue totals and
// exports all still count the invoice. Returns the changed invoices and,
// for any that could not change, the reason.
export async function setInvoicesArchived({ workspaceId, ids, archived, actor = null, req = null }) {
  const list = [...new Set((Array.isArray(ids) ? ids : [ids]).map((x) => String(x || '')).filter(Boolean))];
  if (list.length === 0) throw refused('Pick at least one invoice.');
  if (list.length > ARCHIVE_MAX) throw refused(`You can archive up to ${ARCHIVE_MAX} invoices at a time.`);
  const valid = list.filter((x) => UUID_RE.test(x));
  const { rows } = valid.length
    ? await sql.query('SELECT * FROM invoices WHERE workspace_id = $1 AND id = ANY($2::uuid[])', [workspaceId, valid])
    : { rows: [] };
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  const skipped = [];
  const toChange = [];
  for (const id of list) {
    const row = byId.get(id);
    if (!row) { skipped.push({ id, number: null, why: 'Invoice not found' }); continue; }
    const rule = invoiceActions(row)[archived ? 'archive' : 'unarchive'];
    if (!rule.ok) { skipped.push({ id, number: row.number, why: rule.why }); continue; }
    toChange.push(id);
  }
  let changed = [];
  if (toChange.length) {
    const upd = archived
      ? await sql.query(
        `UPDATE invoices SET archived_at = NOW(), updated_at = NOW()
          WHERE workspace_id = $1 AND id = ANY($2::uuid[])
            AND archived_at IS NULL AND status IN ('paid', 'refunded', 'voided')
          RETURNING *`, [workspaceId, toChange])
      : await sql.query(
        `UPDATE invoices SET archived_at = NULL, updated_at = NOW()
          WHERE workspace_id = $1 AND id = ANY($2::uuid[]) AND archived_at IS NOT NULL
          RETURNING *`, [workspaceId, toChange]);
    changed = upd.rows;
    const done = new Set(changed.map((r) => String(r.id)));
    for (const id of toChange) {
      if (!done.has(id)) skipped.push({ id, number: byId.get(id)?.number || null, why: 'This invoice just changed. Refresh and try again.' });
    }
    if (changed.length) {
      recordWorkspaceAudit(req, {
        workspaceId, actor,
        action: archived ? 'invoice.archive' : 'invoice.unarchive',
        target: { kind: 'invoice', id: changed.length === 1 ? changed[0].id : null },
        meta: { count: changed.length, numbers: changed.slice(0, 50).map((r) => r.number) },
      });
    }
  }
  return { invoices: changed.map(serializeInvoice), changed: changed.length, skipped };
}
