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

export function giftCardRefundableCents(row) {
  if (!row || row.status === 'voided') return 0;
  const notRefunded = Math.max(0, Number(row.original_amount_cents || 0) - Number(row.refunded_cents || 0));
  return Math.max(0, Math.min(Number(row.balance_cents || 0), notRefunded));
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
    // The most a refund can give back: what is left on the card (money
    // already spent stays spent), never more than was paid and not yet
    // refunded. 0 once the card is void.
    refundableCents:     giftCardRefundableCents(row),
    createdAt:           row.created_at,
  };
}

// Public-facing balance lookup. Used by /api/gift-cards/check (public)
// and the booking flow when a code is entered. NEVER returns the full
// code - only display fragments.
// A refund hold (purchaseRefunds.js) older than this belongs to a refund
// that never finished: the request died between holding the amount and
// recording the processor's answer.
export const REFUND_HOLD_TTL_MINUTES = 15;
// At most this many stuck holds are checked per balance read, so a read
// never waits on more than a few processor lookups.
const RECONCILE_LIMIT = 3;

function fmtCents(cents) {
  return '$' + (Number(cents || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// What the processor has refunded on a gift card purchase, in cents.
// Gift cards are sold through Stripe; anything else cannot be checked.
async function processorRefundedCents(workspaceId, paymentIntent) {
  if (!/^(pi_|ch_)/.test(String(paymentIntent || ''))) throw new Error('this payment cannot be looked up');
  const { loadStripeCreds } = await import('./stripeCreds.js');
  const { stripeFetch } = await import('./stripe.js');
  const creds = await loadStripeCreds(workspaceId);
  const key = /^ch_/.test(paymentIntent) ? 'charge' : 'payment_intent';
  const list = await stripeFetch(`/refunds?${key}=${encodeURIComponent(paymentIntent)}&limit=100`, {
    secretKey: creds.secretKey, stripeAccount: creds.stripeAccount,
  });
  if (list?.has_more) throw new Error('too many refunds to check here');
  return (list?.data || [])
    .filter((r) => ['succeeded', 'pending', 'requires_action'].includes(r?.status))
    .reduce((n, r) => n + Math.round(Number(r.amount || 0)), 0);
}

// Settle expired refund holds for one card, one code or a whole business,
// asking the processor first (never on a guess):
//   * the processor shows a refund we never recorded: record it now (the
//     same sync the dashboard path runs; the hold becomes the refund, the
//     balance is not given back);
//   * the processor confirms no refund happened: put the hold back on the
//     balance;
//   * the processor cannot be asked: keep the hold, tell the owner, and
//     check again after another 15 minutes (not on every read).
// Bounded to a few cards per call. Returns how many holds were settled.
export async function releaseStaleGiftCardHolds({ workspaceId, cardId = null, codeHash = null }) {
  if (!workspaceId) return 0;
  const { rows } = await sql`
    SELECT id, stripe_payment_intent, original_amount_cents, refunded_cents, refund_hold_cents, code_last4
      FROM gift_cards
     WHERE workspace_id = ${workspaceId}
       AND refund_hold_cents > 0
       AND (refund_hold_at IS NULL OR refund_hold_at < NOW() - (${String(REFUND_HOLD_TTL_MINUTES)} || ' minutes')::interval)
       AND (${cardId}::uuid IS NULL OR id = ${cardId}::uuid)
       AND (${codeHash}::text IS NULL OR code_hash = ${codeHash}::text)
     ORDER BY refund_hold_at ASC NULLS FIRST
     LIMIT ${RECONCILE_LIMIT}
  `;
  let settled = 0;
  for (const c of rows) {
    const hold = Number(c.refund_hold_cents);
    const refunded = Number(c.refunded_cents || 0);
    let atProcessor;
    try {
      // eslint-disable-next-line no-await-in-loop
      atProcessor = await processorRefundedCents(workspaceId, c.stripe_payment_intent);
    } catch (err) {
      // Not confirmed either way: keep the money held (it is not spent
      // and not handed back), look again later, and tell the owner.
      // eslint-disable-next-line no-await-in-loop
      const kept = await sql`
        UPDATE gift_cards SET refund_hold_at = NOW(), updated_at = NOW()
         WHERE id = ${c.id} AND workspace_id = ${workspaceId} AND refund_hold_cents = ${hold}
        RETURNING id
      `;
      if (kept.rows.length) {
        const { notifyOwnerSafe } = await import('./push.js');
        notifyOwnerSafe({
          workspaceId, type: 'payments',
          payload: {
            title: 'A gift card refund needs a look',
            body: `A ${fmtCents(hold)} refund on the gift card ending ${c.code_last4} did not finish, and your payment processor could not be asked whether it went through. The ${fmtCents(hold)} stays held on the card. Check your payment dashboard; we will look again shortly.`,
            url: '/finance?section=giftcards',
            tag: `gc-hold-${c.id}`,
          },
        });
      }
      console.warn('[gift cards] stuck refund hold kept, processor lookup failed:', c.id, err.message);
      continue;
    }
    if (atProcessor > refunded) {
      // The refund went through: record it like the dashboard path does.
      const { syncRefundToPurchases } = await import('./checkoutFulfillment.js');
      // eslint-disable-next-line no-await-in-loop
      await syncRefundToPurchases({
        workspaceId,
        charge: { payment_intent: c.stripe_payment_intent, amount: Number(c.original_amount_cents), amount_refunded: atProcessor, metadata: {} },
      });
      // Any hold left beyond what the processor refunded goes back.
      // eslint-disable-next-line no-await-in-loop
      await sql`
        UPDATE gift_cards SET
          balance_cents = balance_cents + refund_hold_cents, refund_hold_cents = 0, refund_hold_at = NULL,
          status = CASE WHEN status = 'depleted' THEN 'active' ELSE status END, updated_at = NOW()
         WHERE id = ${c.id} AND workspace_id = ${workspaceId} AND refund_hold_cents > 0 AND refunded_cents = ${atProcessor}
      `;
      settled++;
      continue;
    }
    // Confirmed: no refund happened. Put the hold back (only if nothing
    // moved since we looked).
    // eslint-disable-next-line no-await-in-loop
    const back = await sql`
      UPDATE gift_cards SET
        balance_cents     = balance_cents + refund_hold_cents,
        refund_hold_cents = 0,
        refund_hold_at    = NULL,
        status            = CASE WHEN status = 'depleted' THEN 'active' ELSE status END,
        updated_at        = NOW()
      WHERE id = ${c.id} AND workspace_id = ${workspaceId}
        AND refund_hold_cents = ${hold} AND refunded_cents = ${refunded}
      RETURNING id
    `;
    if (back.rows.length) settled++;
  }
  return settled;
}

export async function findActiveByCode(workspaceId, rawCode) {
  const norm = normalizeCode(rawCode);
  if (norm.length < 8) return null;
  const hash = hashCode(norm);
  await releaseStaleGiftCardHolds({ workspaceId, codeHash: hash }).catch(() => {});
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
// already recorded (net of any refunded since: money given back is owed
// again) and any gift card credit already applied.
export function invoiceDueCents(inv) {
  const totals = computeTotals(inv.items || [], inv.tax_rate, inv.discount);
  const paid = Math.round(Number(inv.paid_amount || 0) * 100);
  const refunded = Math.min(paid, Math.max(0, Math.round(Number(inv.refunded_amount || 0) * 100)));
  const credit = Math.max(0, Number(inv.gift_card_credit_cents || 0) - Number(inv.gift_card_credit_restored_cents || 0));
  return Math.max(0, Math.round(totals.total * 100) - (paid - refunded) - credit);
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

// Undo restoreGiftCardCreditForInvoice: a refund that had put the
// invoice's gift card credit back on the card turned out not to go through
// (the processor failed it later), so the credit comes back off the card.
// Exactly once (the invoice's restored cents are claimed first). Never
// below zero: if the client already spent some of it, only what is left is
// taken and the rest is returned as shortCents for the caller to report.
// Returns { wantedCents, takenCents, shortCents }.
export async function retakeGiftCardCreditForInvoice({ workspaceId, invoiceId }) {
  const claim = await sql`
    UPDATE invoices i SET gift_card_credit_restored_cents = 0, updated_at = NOW()
    FROM invoices prev
    WHERE prev.id = i.id
      AND i.id = ${invoiceId} AND i.workspace_id = ${workspaceId}
      AND i.gift_card_credit_restored_cents > 0
    RETURNING prev.gift_card_credit_restored_cents AS wanted, i.gift_card_id
  `;
  if (claim.rows.length === 0) return { wantedCents: 0, takenCents: 0, shortCents: 0 };
  const wanted = Number(claim.rows[0].wanted || 0);
  let cardId = claim.rows[0].gift_card_id;
  if (!cardId) {
    const r = await sql`
      SELECT gift_card_id FROM gift_card_redemptions
       WHERE workspace_id = ${workspaceId} AND applied_to_kind = 'invoice' AND applied_to_id = ${invoiceId}
       ORDER BY created_at DESC LIMIT 1
    `;
    cardId = r.rows[0]?.gift_card_id || null;
  }
  if (!cardId) return { wantedCents: wanted, takenCents: 0, shortCents: wanted };
  const upd = await sql`
    UPDATE gift_cards g SET
      balance_cents = g.balance_cents - LEAST(g.balance_cents, ${wanted}),
      status        = CASE WHEN g.status = 'active' AND g.balance_cents - LEAST(g.balance_cents, ${wanted}) <= 0 THEN 'depleted' ELSE g.status END,
      updated_at    = NOW()
    FROM gift_cards prev
    WHERE prev.id = g.id AND g.id = ${cardId} AND g.workspace_id = ${workspaceId}
    RETURNING LEAST(prev.balance_cents, ${wanted}) AS taken
  `;
  const taken = Number(upd.rows[0]?.taken || 0);
  return { wantedCents: wanted, takenCents: taken, shortCents: wanted - taken };
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
