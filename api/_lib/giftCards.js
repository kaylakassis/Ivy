// Helpers for gift cards. Codes are generated client-side at issue
// time, hashed before storage (so a leaked DB doesn't immediately
// give attackers usable codes), and never decrypted — recipient sees
// the raw code via email; redemption looks up by hash.
import crypto from 'node:crypto';
import { sql } from './db.js';

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
    senderName:          row.sender_name,
    senderEmail:         row.sender_email,
    recipientName:       row.recipient_name,
    recipientEmail:      row.recipient_email,
    message:             row.message,
    expiresAt:           row.expires_at,
    status:              row.status,
    createdAt:           row.created_at,
  };
}

// Public-facing balance lookup. Used by /api/gift-cards/check (public)
// and the booking flow when a code is entered. NEVER returns the full
// code — only display fragments.
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
