// Helpers for gift cards. Codes are generated client-side at issue
// time, hashed before storage (so a leaked DB doesn't immediately
// give attackers usable codes), and never decrypted - recipient sees
// the raw code via email; redemption looks up by hash.
import crypto from 'node:crypto';
import { sql } from './db.js';
import { computeTotals } from './finance.js';

// Generate a 14-character ambiguity-free code, e.g. "G2HK-LM8X-PJ7Q".
// 12 entropy chars + 2 dashes = 14 total. ~10^17 keyspace which is
// fine for the volume; we also rate-limit lookups + lock cards
// after multiple failed attempts at apply time.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function generateCode() {
  const buf = crypto.randomBytes(12);
  let s = '';
  for (let i = 0; i < 12; i++) s += ALPHABET[buf[i] % ALPHABET.length];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}

export function normalizeCode(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function hashCode(rawNormalized) {
  return crypto.createHash('sha256').update(String(rawNormalized)).digest('hex');
}

export function serializeGiftCard(row) {
  if (!row) return null;
  return {
    id:                  row.id,
    codeLast4:           row.code_last4,
    originalAmountCents: Number(row.original_amount_cents || 0),
    balanceCents:        Number(row.balance_cents || 0),
    refundedCents:       Number(row.refunded_cents || 0),
    senderName:          row.sender_name,
    senderEmail:         row.sender_email,
    recipientName:       row.recipient_name,
    recipientEmail:      row.recipient_email,
    message:             row.message,
    expiresAt:           row.expires_at,
    status:              row.status,
    // Sold through the public page (so a refund can go back through the
    // processor). Owner-issued cards would be false.
    paidOnline:          !!row.stripe_payment_intent,
    createdAt:           row.created_at,
  };
}

// Public-facing balance lookup. Used by /api/gift-cards/check (public)
// and the booking flow when a code is entered. NEVER returns the full
// code - only display fragments.
export async function findActiveByCode(workspaceId, rawCode) {
  const norm = normalizeCode(rawCode);
  if (norm.length < 8) return null;
  const hash = hashCode(norm);
  const r = await sql`
    SELECT * FROM gift_cards
     WHERE workspace_id = ${workspaceId}
       AND code_hash = ${hash}
       AND status = 'active'
       AND (expires_at IS NULL OR expires_at > NOW())
       AND balance_cents > 0
     LIMIT 1
  `;
  return r.rows[0] || null;
}

// Atomically debit a gift card and write a redemption row.
// Caller should have already validated balance >= amount; this
// re-checks under the lock so concurrent redemptions can't
// over-spend the same card.
export async function redeemAtomic({
  giftCardId, workspaceId, amountCents, appliedToKind, appliedToId, clientId,
}) {
  // Decrement balance only if there's enough. RETURNING tells us
  // whether the row updated (i.e. the card had enough balance).
  const upd = await sql`
    UPDATE gift_cards SET
      balance_cents = balance_cents - ${amountCents},
      status        = CASE WHEN balance_cents - ${amountCents} <= 0 THEN 'depleted' ELSE status END,
      updated_at    = NOW()
    WHERE id = ${giftCardId}
      AND workspace_id = ${workspaceId}
      AND status = 'active'
      AND balance_cents >= ${amountCents}
    RETURNING balance_cents
  `;
  if (upd.rows.length === 0) {
    throw Object.assign(new Error('Gift card has insufficient balance'), { code: 'insufficient' });
  }
  await sql`
    INSERT INTO gift_card_redemptions (
      gift_card_id, workspace_id, amount_cents,
      applied_to_kind, applied_to_id, client_id
    ) VALUES (
      ${giftCardId}, ${workspaceId}, ${amountCents},
      ${appliedToKind}, ${appliedToId}, ${clientId}
    )
  `;
  return upd.rows[0].balance_cents;
}

// Put a cancelled booking's gift-card credit back on the card.
// Exactly-once: zeroing bookings.gift_card_credit_cents (only when > 0)
// is the atomic claim, so double-invocation (owner delete + portal
// cancel racing, or a retry) restores at most once. The card comes from
// the redemption audit row written at booking time. Returns the number
// of cents restored (0 = nothing to do / already restored).
export async function restoreGiftCardCreditForBooking({ workspaceId, bookingId }) {
  // Self-join so RETURNING gives the PRE-update amount (a plain
  // RETURNING would hand back the 0 we just wrote), which the failure
  // path below needs in order to hand the credit back.
  const claim = await sql`
    UPDATE bookings b SET gift_card_credit_cents = 0, updated_at = NOW()
    FROM bookings prev
    WHERE prev.id = b.id
      AND b.id = ${bookingId} AND b.workspace_id = ${workspaceId}
      AND b.gift_card_credit_cents > 0
    RETURNING prev.gift_card_credit_cents AS before_cents
  `;
  if (claim.rows.length === 0) return 0;
  const claimedBefore = Number(claim.rows[0]?.before_cents || 0);
  let restored = 0;
  try {
    const reds = await sql`
      SELECT gift_card_id, SUM(amount_cents)::int AS amt
        FROM gift_card_redemptions
       WHERE workspace_id = ${workspaceId}
         AND applied_to_kind = 'booking'
         AND applied_to_id = ${bookingId}
       GROUP BY gift_card_id
    `;
    for (const row of reds.rows) {
      const amt = Number(row.amt || 0);
      if (amt <= 0) continue;
      // Re-crediting revives a depleted card; voided/expired cards get the
      // balance back too (harmless - they stay unusable until the owner
      // reactivates them).
      await sql`
        UPDATE gift_cards SET
          balance_cents = balance_cents + ${amt},
          status        = CASE WHEN status = 'depleted' THEN 'active' ELSE status END,
          updated_at    = NOW()
        WHERE id = ${row.gift_card_id} AND workspace_id = ${workspaceId}
      `;
      restored += amt;
    }
  } catch (err) {
    // The claim already zeroed the booking's credit. If crediting the
    // card failed partway, hand the UNRESTORED remainder back to the
    // booking so a later call can claim it again - otherwise a transient
    // DB error would silently vaporize the customer's prepaid money.
    await sql`
      UPDATE bookings SET gift_card_credit_cents = ${Math.max(0, claimedBefore - restored)}
      WHERE id = ${bookingId} AND workspace_id = ${workspaceId}
    `.catch(() => {});
    throw err;
  }
  return restored;
}

// ─── Gift cards on invoices ──────────────────────────────────────────

function fmtMoney(cents) {
  return '$' + (Number(cents || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// What is still owed on an invoice row, in cents, after partial payments
// already recorded and any gift card credit already applied.
export function invoiceDueCents(inv) {
  const totals = computeTotals(inv.items || [], inv.tax_rate, inv.discount);
  const paid = Math.round(Number(inv.paid_amount || 0) * 100);
  const credit = Number(inv.gift_card_credit_cents || 0);
  return Math.max(0, Math.round(totals.total * 100) - paid - credit);
}

// Apply a gift card to a sent invoice. `inv` is the full invoices row (the
// caller found it by its public token or as the owner); `card` is the row
// findActiveByCode returned for the INVOICE's workspace, so a card from
// another business can never reach this point. Applies the lesser of the
// balance and what is still due, never below zero on either side.
//
// Order of operations keeps both rows honest under concurrency: the
// invoice is claimed first (gift_card_credit_cents must still be 0, so a
// credit is never applied twice), then the card is debited atomically.
// If the card lost a race and no longer has the balance, the claim is
// rolled back and the caller gets code 'insufficient'.
//
// Returns { appliedCents, remainingCents, invoice } - the caller decides
// whether a zero remainder means "mark paid" (api/invoice-pay/gift-card.js
// does, through markInvoicePaid so receipts fire).
export async function applyGiftCardToInvoice({ inv, card }) {
  if (!inv || !card) throw Object.assign(new Error('Gift card not found'), { code: 'not_found' });
  if (card.workspace_id !== inv.workspace_id) throw Object.assign(new Error('Gift card not found'), { code: 'not_found' });
  if (Number(inv.gift_card_credit_cents || 0) > 0) {
    throw Object.assign(new Error('A gift card has already been applied to this invoice'), { code: 'already_applied' });
  }
  const due = invoiceDueCents(inv);
  if (due <= 0) throw Object.assign(new Error('Nothing left to pay on this invoice'), { code: 'nothing_due' });
  const applied = Math.min(due, Math.max(0, Number(card.balance_cents || 0)));
  if (applied <= 0) throw Object.assign(new Error('Gift card has insufficient balance'), { code: 'insufficient' });

  const activity = [
    ...(inv.activity || []),
    { ts: new Date().toISOString(), kind: 'gift-card',
      text: `Gift card ending ${card.code_last4} applied · ${fmtMoney(applied)}` },
  ];
  const claim = await sql`
    UPDATE invoices SET
      gift_card_credit_cents = ${applied},
      gift_card_id           = ${card.id},
      gift_card_code_last4   = ${card.code_last4},
      activity               = ${JSON.stringify(activity)}::jsonb,
      updated_at             = NOW()
    WHERE id = ${inv.id} AND workspace_id = ${inv.workspace_id}
      AND gift_card_credit_cents = 0
      AND status IN ('sent', 'overdue')
      AND payment_processing_at IS NULL
    RETURNING *
  `;
  if (claim.rows.length === 0) {
    throw Object.assign(new Error('A gift card has already been applied to this invoice'), { code: 'already_applied' });
  }
  try {
    await redeemAtomic({
      giftCardId: card.id, workspaceId: inv.workspace_id, amountCents: applied,
      appliedToKind: 'invoice', appliedToId: inv.id, clientId: inv.client_id || null,
    });
  } catch (err) {
    await sql`
      UPDATE invoices SET
        gift_card_credit_cents = 0, gift_card_id = NULL, gift_card_code_last4 = NULL,
        activity = ${JSON.stringify(inv.activity || [])}::jsonb, updated_at = NOW()
      WHERE id = ${inv.id} AND workspace_id = ${inv.workspace_id} AND gift_card_credit_cents = ${applied}
    `.catch(() => {});
    throw err;
  }
  return { appliedCents: applied, remainingCents: due - applied, invoice: claim.rows[0] };
}

// Put an invoice's gift-card credit back on the card: all of it (void, a
// full refund) or `amountCents` of it (a partial refund of an invoice the
// card paid for). Exactly-once per cent: the atomic claim moves
// invoices.gift_card_credit_restored_cents and never past
// gift_card_credit_cents, so a void followed by a refund, or two retries,
// restore the credit once. Returns the cents restored (0 = nothing left).
export async function restoreGiftCardCreditForInvoice({ workspaceId, invoiceId, amountCents = null }) {
  const want = amountCents == null ? 2_147_483_647 : Math.max(0, Math.round(Number(amountCents)));
  if (want <= 0) return 0;
  const claim = await sql`
    UPDATE invoices i SET
      gift_card_credit_restored_cents = i.gift_card_credit_restored_cents
        + LEAST(${want}, i.gift_card_credit_cents - i.gift_card_credit_restored_cents),
      updated_at = NOW()
    FROM invoices prev
    WHERE prev.id = i.id
      AND i.id = ${invoiceId} AND i.workspace_id = ${workspaceId}
      AND i.gift_card_credit_cents - i.gift_card_credit_restored_cents > 0
    RETURNING (i.gift_card_credit_restored_cents - prev.gift_card_credit_restored_cents) AS restored_now, i.gift_card_id
  `;
  if (claim.rows.length === 0) return 0;
  const restored = Number(claim.rows[0].restored_now || 0);
  if (restored <= 0) return 0;
  try {
    let cardId = claim.rows[0].gift_card_id;
    if (!cardId) {
      const r = await sql`
        SELECT gift_card_id FROM gift_card_redemptions
         WHERE workspace_id = ${workspaceId} AND applied_to_kind = 'invoice' AND applied_to_id = ${invoiceId}
         ORDER BY created_at DESC LIMIT 1
      `;
      cardId = r.rows[0]?.gift_card_id || null;
    }
    if (!cardId) throw new Error('gift card for this invoice no longer exists');
    const upd = await sql`
      UPDATE gift_cards SET
        balance_cents = balance_cents + ${restored},
        status        = CASE WHEN status = 'depleted' THEN 'active' ELSE status END,
        updated_at    = NOW()
      WHERE id = ${cardId} AND workspace_id = ${workspaceId}
      RETURNING id
    `;
    if (upd.rows.length === 0) throw new Error('gift card for this invoice no longer exists');
  } catch (err) {
    // Hand the claim back so a later call can restore it; prepaid money
    // must not vanish on a transient error.
    await sql`
      UPDATE invoices SET gift_card_credit_restored_cents = GREATEST(0, gift_card_credit_restored_cents - ${restored})
      WHERE id = ${invoiceId} AND workspace_id = ${workspaceId}
    `.catch(() => {});
    throw err;
  }
  return restored;
}
