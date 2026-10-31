// POST /api/invoice-pay/gift-card  (public, no auth)
//   body { token, code, action: 'check' | 'apply' }
//
// The client types a gift card code on the public invoice page.
//   check  → balance / last4 / expiry of the card plus how much of it would
//            come off THIS invoice. Nothing changes.
//   apply  → debits the card and records the credit on the invoice (one
//            card per invoice, never twice, never below zero on either
//            side). If the credit covers everything that is due, the
//            invoice is marked paid through markInvoicePaid - the same
//            path a card payment takes - so the receipt, the owner push
//            and the milestones fire exactly as they would for any other
//            payment. Otherwise the remainder stays due and the page lets
//            the client pay it by card or by the manual methods.
//
// Token auth matches /api/invoice-view/:token: the sha256 of the raw view
// token must match a 'sent' or 'overdue' invoice. The card is looked up in
// the INVOICE's workspace only, so a card from another business is simply
// "not found" here. Per-IP rate limit mirrors /api/gift-cards/check so
// codes cannot be brute-forced from an invoice link.
import crypto from 'node:crypto';
import { sql } from '../_lib/db.js';
import { readBody } from '../_lib/body.js';
import { enforce, getClientIp } from '../_lib/rate-limit.js';
import { findActiveByCode, applyGiftCardToInvoice, invoiceDueCents } from '../_lib/giftCards.js';
import { markInvoicePaid } from '../_lib/invoicePayments.js';
import { serializeInvoicePublic, fetchEnabledManualMethods } from '../_lib/finance.js';
import { invoiceBusinessMeta } from '../_lib/branding.js';
import { notifyOwnerSafe } from '../_lib/push.js';
import { isPaymentReady } from '../invoice-view/[token].js';
import { badRequest, methodNotAllowed, notFound, ok, serverError } from '../_lib/json.js';
import { ensureSchemaApplied } from '../_lib/ensureSchema.js';

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}
function fmtMoney(cents) {
  return '$' + (Number(cents || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try { await ensureSchemaApplied(); } catch { /* tolerate */ }
  try {
    const ip = getClientIp(req);
    const blocked = await enforce(req, res, [
      { key: `invgc:ip:${ip}`, max: 30, windowSeconds: 60 * 60 },
    ]);
    if (blocked) return;

    const body = await readBody(req);
    const rawToken = (body.token || req.query?.token || '').toString();
    if (typeof rawToken !== 'string' || rawToken.length < 16) {
      return notFound(res, 'This invoice link is invalid or has expired.');
    }
    const code = (body.code || '').toString();
    if (!code.trim()) return badRequest(res, 'Enter the gift card code.');
    const action = body.action === 'apply' ? 'apply' : 'check';

    const { rows } = await sql`
      SELECT * FROM invoices
      WHERE view_token_hash = ${hashToken(rawToken)}
        AND status IN ('sent', 'overdue')
      LIMIT 1
    `;
    const inv = rows[0];
    if (!inv) return notFound(res, 'This invoice link is invalid, has expired, or was already paid.');
    if (inv.payment_processing_at) {
      return badRequest(res, 'A bank payment for this invoice is already on its way, so a gift card cannot be applied.');
    }
    if (Number(inv.gift_card_credit_cents || 0) > 0) {
      return badRequest(res, 'A gift card has already been applied to this invoice.');
    }
    const due = invoiceDueCents(inv);
    if (due <= 0) return badRequest(res, 'Nothing left to pay on this invoice.');

    // Scoped to the invoice's workspace: another business's card is unknown here.
    const card = await findActiveByCode(inv.workspace_id, code);
    if (!card) return notFound(res, 'Gift card not found or already used');
    const balance = Number(card.balance_cents || 0);
    const applies = Math.min(balance, due);

    if (action === 'check') {
      return ok(res, {
        card: { codeLast4: card.code_last4, balanceCents: balance, expiresAt: card.expires_at },
        appliesCents: applies,
        remainingCents: due - applies,
      });
    }

    let result;
    try {
      result = await applyGiftCardToInvoice({ inv, card });
    } catch (err) {
      if (err.code === 'already_applied') return badRequest(res, 'A gift card has already been applied to this invoice.');
      if (err.code === 'insufficient') return badRequest(res, 'That gift card was just used elsewhere. Check the balance and try again.');
      if (err.code === 'nothing_due') return badRequest(res, 'Nothing left to pay on this invoice.');
      throw err;
    }

    const businessName = (await invoiceBusinessMeta(inv.workspace_id))?.name || 'the business';
    if (result.remainingCents === 0) {
      // Fully covered: the same transition a card payment makes, so the
      // receipt / owner push / milestones all fire from one place.
      const marked = await markInvoicePaid({
        workspaceId: inv.workspace_id, invoiceId: inv.id, paymentIntent: null,
        amountCents: result.appliedCents, method: 'gift_card',
      });
      return ok(res, {
        applied: true, paid: marked === 'paid' || marked === 'already-paid',
        appliedCents: result.appliedCents, remainingCents: 0,
        giftCard: { codeLast4: card.code_last4, balanceLeftCents: Math.max(0, balance - result.appliedCents) },
        business: businessName,
      });
    }

    notifyOwnerSafe({
      workspaceId: inv.workspace_id, type: 'payments',
      payload: {
        title: 'Gift card applied to an invoice',
        body: `${inv.client_name || 'A client'} · ${inv.number} · ${fmtMoney(result.appliedCents)} from the card ending ${card.code_last4}; ${fmtMoney(result.remainingCents)} still due.`,
        url: `/finance?invoice=${inv.id}`,
        tag: `invoice-gift-card-${inv.id}`,
      },
    });
    const [business, paymentEnabled, manualMethods] = await Promise.all([
      invoiceBusinessMeta(inv.workspace_id),
      isPaymentReady(inv.workspace_id),
      fetchEnabledManualMethods(inv.workspace_id),
    ]);
    return ok(res, {
      applied: true, paid: false,
      appliedCents: result.appliedCents, remainingCents: result.remainingCents,
      giftCard: { codeLast4: card.code_last4, balanceLeftCents: Math.max(0, balance - result.appliedCents) },
      business: businessName,
      invoice: serializeInvoicePublic(result.invoice, { business, manualMethods, paymentEnabled }),
    });
  } catch (err) {
    return serverError(res, err);
  }
}
