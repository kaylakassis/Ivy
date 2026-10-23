// "Client says they paid" for manual payment methods (Zelle, Venmo, Cash
// App, cash, check). Nothing moves money through Ivy: the client tells us
// they sent it, we stamp the invoice and tell the owner, and the owner
// confirms from the invoice drawer (mark-paid) or clears it (clear-claim).
//
//   recordPaymentClaim   - stamps payment_claimed_* on the invoice and,
//                          at most once per 24h per invoice, notifies the
//                          owner (push + email + system message in the
//                          client's thread). Idempotent; a second tap
//                          updates the method/time quietly.
//   clearPaymentClaim    - owner says "not received": wipes the claim so
//                          the client can tap again later, and optionally
//                          messages the client.
import { sql } from './db.js';
import { sendEmailToUser, emailShell } from './email.js';
import { notifyOwnerSafe, notifyClientSafe } from './push.js';
import { fetchBranding } from './branding.js';
import { appUrl } from './tokens.js';
import { reportError } from './monitoring.js';
import { computeTotals, MANUAL_METHOD_TYPES, paidMethodLabel } from './finance.js';

const CLAIM_NOTE_MAX = 280;
const NOTIFY_WINDOW = '24 hours';

function fmtMoney(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function cleanClaimMethod(method) {
  const m = String(method || 'other').toLowerCase().trim();
  return MANUAL_METHOD_TYPES.has(m) ? m : 'other';
}

// `inv` is the full invoices row (already looked up by token and known
// to be sent/overdue). Returns { claimedAt, method, notified }.
export async function recordPaymentClaim({ inv, method, note }) {
  const m = cleanClaimMethod(method);
  const n = note ? String(note).slice(0, CLAIM_NOTE_MAX) : null;
  const label = paidMethodLabel(m);
  const newActivity = [
    ...(inv.activity || []),
    {
      ts: new Date().toISOString(),
      kind: 'client-marked-paid',
      text: `${inv.client_name || 'Recipient'} says they paid by ${label}${n ? ` - "${n}"` : ''}`,
    },
  ];
  // One statement decides both the stamp and whether THIS call gets to
  // notify: notified_at only moves when it is empty or older than the
  // window, and NOW() is constant within the statement, so comparing the
  // two tells us if we just set it. Two concurrent taps cannot both win.
  const upd = await sql`
    UPDATE invoices SET
      payment_claimed_at = NOW(),
      payment_claimed_method = ${m},
      payment_claimed_note = ${n},
      payment_claim_notified_at = CASE
        WHEN payment_claim_notified_at IS NULL
          OR payment_claim_notified_at < NOW() - ${NOTIFY_WINDOW}::interval
        THEN NOW() ELSE payment_claim_notified_at END,
      activity = ${JSON.stringify(newActivity)}::jsonb,
      updated_at = NOW()
    WHERE id = ${inv.id} AND workspace_id = ${inv.workspace_id}
      AND status IN ('sent', 'overdue')
    RETURNING payment_claimed_at, (payment_claim_notified_at = NOW()) AS notified_now
  `;
  const row = upd.rows[0];
  if (!row) return null;
  if (row.notified_now) {
    await notifyPaymentClaimed({ workspaceId: inv.workspace_id, invoiceId: inv.id });
  }
  return { claimedAt: row.payment_claimed_at, method: m, notified: !!row.notified_now };
}

// Owner-facing: push + email + a system line in the client's thread, the
// same shape booking notifications use. Best-effort - never throws.
export async function notifyPaymentClaimed({ workspaceId, invoiceId }) {
  try {
    const { rows } = await sql`
      SELECT i.id, i.number, i.client_id, i.client_name, i.items, i.tax_rate, i.discount,
             i.payment_claimed_method, i.payment_claimed_note,
             w.owner_id, u.email AS owner_email, u.name AS owner_name
        FROM invoices i
        JOIN workspaces w ON w.id = i.workspace_id
        LEFT JOIN users u ON u.id = w.owner_id
       WHERE i.id = ${invoiceId} AND i.workspace_id = ${workspaceId}
    `;
    const inv = rows[0];
    if (!inv) return;
    const totals = computeTotals(inv.items, inv.tax_rate, inv.discount);
    const label = paidMethodLabel(inv.payment_claimed_method);
    const client = inv.client_name || 'A client';
    const amount = fmtMoney(totals.total);
    const summary = `${client} says they paid invoice ${inv.number} (${amount}) by ${label}. Confirm it in Finance.`;
    const url = `/finance?invoice=${inv.id}`;
    const branding = await fetchBranding(workspaceId);
    const business = branding.businessName || 'the business';

    const tasks = [];

    tasks.push(notifyOwnerSafe({
      workspaceId,
      type: 'payments',
      payload: {
        title: 'Payment to confirm',
        body: summary,
        url,
        tag: `invoice-claim-${inv.id}`,
      },
    }));

    if (inv.owner_email) {
      const greeting = inv.owner_name ? `Hi ${escapeHtml(inv.owner_name.split(/\s+/)[0])},` : 'Hi,';
      const html = emailShell({
        heading: 'A client says they paid',
        branding,
        body: `<p>${greeting}</p>
          <p><strong>${escapeHtml(client)}</strong> says they paid invoice
          <strong>${escapeHtml(inv.number)}</strong> (${escapeHtml(amount)}) by <strong>${escapeHtml(label)}</strong>.</p>
          ${inv.payment_claimed_note ? `<p style="color:#85827B;">Their note: "${escapeHtml(inv.payment_claimed_note)}"</p>` : ''}
          <p>Check your ${escapeHtml(label)} account. Once the money is there, confirm it in Finance and
          the invoice is marked paid and the client gets a receipt. If it never shows up, mark it
          not received and the client can try again.</p>`,
        ctaText: 'Confirm in Finance',
        ctaUrl: `${appUrl()}${url}`,
        footer: 'Ivy never moves money for these payments. It only tracks what the client told you.',
      });
      tasks.push(sendEmailToUser({
        userId: inv.owner_id, type: 'invoices',
        to: inv.owner_email,
        subject: `${client} says they paid ${inv.number} by ${label}`,
        html,
      }));
    }

    if (inv.client_id) {
      tasks.push(upsertThreadAndSystemMessage({
        workspaceId,
        clientId: inv.client_id,
        text: `Payment sent for invoice ${inv.number} (${amount}) by ${label}. Waiting for ${business} to confirm.`,
        kind: 'invoice-claimed',
        meta: { invoiceId: inv.id, number: inv.number, total: totals.total, method: inv.payment_claimed_method },
      }));
    }

    const results = await Promise.allSettled(tasks);
    for (const r of results) {
      if (r.status === 'rejected') {
        console.error('[notifyPaymentClaimed] subtask failed:', r.reason?.message || r.reason);
        reportError(r.reason, { extra: { invoiceId, workspaceId } });
      }
    }
  } catch (err) {
    console.error('[notifyPaymentClaimed] failed:', err.message);
    reportError(err, { extra: { invoiceId, workspaceId } });
  }
}

// Owner says the money never arrived. Wipes the claim (and the notify
// stamp, so a fresh claim after this reaches the owner again) and, when
// `message` is given, drops it into the client's thread from the business.
export async function clearPaymentClaim({ inv, workspaceId, message }) {
  const label = paidMethodLabel(inv.payment_claimed_method);
  const newActivity = [
    ...(inv.activity || []),
    { ts: new Date().toISOString(), kind: 'not-received', text: `Marked not received (client said ${label})` },
  ];
  const upd = await sql`
    UPDATE invoices SET
      payment_claimed_at = NULL,
      payment_claimed_method = NULL,
      payment_claimed_note = NULL,
      payment_claim_notified_at = NULL,
      activity = ${JSON.stringify(newActivity)}::jsonb,
      updated_at = NOW()
    WHERE id = ${inv.id} AND workspace_id = ${workspaceId}
    RETURNING *
  `;
  const row = upd.rows[0];
  if (!row) return null;

  const text = message ? String(message).trim().slice(0, 1000) : '';
  if (text && inv.client_id) {
    try {
      const t = await sql`
        INSERT INTO message_threads (workspace_id, client_id)
        VALUES (${workspaceId}, ${inv.client_id})
        ON CONFLICT (workspace_id, client_id) DO UPDATE SET workspace_id = EXCLUDED.workspace_id
        RETURNING id
      `;
      const threadId = t.rows[0].id;
      await sql`
        INSERT INTO messages (thread_id, sender, text, kind, meta)
        VALUES (${threadId}, 'biz', ${text}, 'invoice-not-received',
                ${JSON.stringify({ invoiceId: inv.id, number: inv.number })}::jsonb)
      `;
      await sql`
        UPDATE message_threads SET
          last_message_at = NOW(),
          last_message_preview = ${text.slice(0, 200)},
          unread_client = unread_client + 1
        WHERE id = ${threadId}
      `;
      notifyClientSafe({
        clientId: inv.client_id,
        type: 'messages',
        payload: {
          title: 'New message',
          body: text.slice(0, 200),
          url: `/me/messages?threadId=${threadId}`,
          tag: `thread-${threadId}`,
        },
      });
    } catch (err) {
      console.error('[clearPaymentClaim] client message failed:', err.message);
    }
  }
  return row;
}

async function upsertThreadAndSystemMessage({ workspaceId, clientId, text, kind, meta }) {
  const t = await sql`
    INSERT INTO message_threads (workspace_id, client_id)
    VALUES (${workspaceId}, ${clientId})
    ON CONFLICT (workspace_id, client_id) DO UPDATE SET workspace_id = EXCLUDED.workspace_id
    RETURNING id
  `;
  const threadId = t.rows[0].id;
  await sql`
    INSERT INTO messages (thread_id, sender, text, kind, meta)
    VALUES (${threadId}, 'system', ${text}, ${kind}, ${JSON.stringify(meta)}::jsonb)
  `;
  await sql`
    UPDATE message_threads SET
      last_message_at = NOW(),
      last_message_preview = ${text.slice(0, 200)},
      unread_biz = unread_biz + 1
    WHERE id = ${threadId}
  `;
}
