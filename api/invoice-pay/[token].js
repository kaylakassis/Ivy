// POST /api/invoice-pay/:token  (public, no auth)
// Creates a Stripe Checkout Session for the invoice this token represents
// and returns its URL. The browser redirects there; on completion Stripe
// posts to /api/webhooks/stripe/<workspaceId> which marks the invoice paid.
//
// Token authentication is identical to /api/invoice-view/:token — the same
// sha256-hashed view token must match an invoice in 'sent' or 'overdue'.
//
// Idempotent-ish: a second call replaces the stored session id with a fresh
// one. Stripe doesn't auto-expire abandoned sessions for hours, so reusing
// the previous URL would also work — but issuing a new session is simpler
// than tracking expiry on our side.
import { sql } from '../_lib/db.js';
import { enforce, getClientIp } from '../_lib/rate-limit.js';
import { computeTotals } from '../_lib/finance.js';
import { decrypt } from '../_lib/secrets.js';
import { createCheckoutSession } from '../_lib/stripe.js';
import { appUrl } from '../_lib/tokens.js';
import { badRequest, methodNotAllowed, notFound, ok, serverError } from '../_lib/json.js';
import crypto from 'node:crypto';

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try {
    const ip = getClientIp(req);
    const blocked = await enforce(req, res, [
      { key: `invpay:ip:${ip}`, max: 10, windowSeconds: 60 * 60 },
    ]);
    if (blocked) return;

    const rawToken = (req.query.token || '').toString();
    if (typeof rawToken !== 'string' || rawToken.length < 16) {
      return notFound(res, 'Invalid invoice link.');
    }
    const tokenHash = hashToken(rawToken);

    const { rows: invRows } = await sql`
      SELECT * FROM invoices
      WHERE view_token_hash = ${tokenHash}
        AND status IN ('sent', 'overdue')
      LIMIT 1
    `;
    const inv = invRows[0];
    if (!inv) return notFound(res, 'This invoice link is invalid, has expired, or was already paid.');

    // Load Stripe creds for the issuing workspace.
    const { rows: csRows } = await sql`
      SELECT
        stripe_secret_encrypted,
        stripe_webhook_secret_encrypted IS NOT NULL AS webhook_configured,
        currency
      FROM finance_settings
      WHERE workspace_id = ${inv.workspace_id}
    `;
    const cs = csRows[0];
    if (!cs?.stripe_secret_encrypted || !cs.webhook_configured) {
      return badRequest(res, 'Online payment is not enabled for this invoice.');
    }

    let secretKey;
    try {
      secretKey = decrypt(cs.stripe_secret_encrypted);
    } catch {
      return serverError(res, new Error('Could not load payment credentials.'));
    }

    const totals = computeTotals(inv.items || [], inv.tax_rate, inv.discount);
    if (!(totals.total > 0)) return badRequest(res, 'Nothing to pay on this invoice.');
    const totalCents = Math.round(totals.total * 100);
    const currency = (cs.currency || 'USD').toUpperCase();

    const base = appUrl();
    // Land back on the public invoice with a flag the UI uses to show a
    // "thanks — payment received" state. The webhook is the source of truth
    // for the actual paid status.
    const successUrl = `${base}/invoice/${encodeURIComponent(rawToken)}?paid=1`;
    const cancelUrl  = `${base}/invoice/${encodeURIComponent(rawToken)}?cancelled=1`;

    const session = await createCheckoutSession({
      secretKey,
      invoice: { id: inv.id, number: inv.number, workspace_id: inv.workspace_id },
      currency,
      totalCents,
      successUrl,
      cancelUrl,
      customerEmail: inv.client_email || undefined,
    });

    await sql`
      UPDATE invoices SET stripe_session_id = ${session.id}, updated_at = NOW()
      WHERE id = ${inv.id}
    `;

    return ok(res, { url: session.url });
  } catch (err) {
    return serverError(res, err);
  }
}
