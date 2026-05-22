// /api/invoice-view/:token  (public, no auth)
//   GET   → public invoice payload (only if status='sent' or 'overdue')
//   POST  → optional "I've paid" confirmation. Doesn't actually settle the
//           invoice; the live pay flow is /api/invoice-pay/[token] (Stripe/
//           Square/PayPal). This POST records a soft "client says paid"
//           the owner sees, so they can reconcile.
//
// Token is sha256-hashed before lookup.
import { sql } from '../_lib/db.js';
import { readBody } from '../_lib/body.js';
import { enforce, getClientIp } from '../_lib/rate-limit.js';
import { serializeInvoicePublic } from '../_lib/finance.js';
import { reconcileStripeInvoice } from '../_lib/invoicePayments.js';
import { badRequest, methodNotAllowed, notFound, ok, serverError } from '../_lib/json.js';
import { ensureSchemaApplied } from '../_lib/ensureSchema.js';
import crypto from 'node:crypto';

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

async function fetchByToken(rawToken) {
  if (typeof rawToken !== 'string' || rawToken.length < 16) return null;
  const tokenHash = hashToken(rawToken);
  const { rows } = await sql`
    SELECT * FROM invoices
    WHERE view_token_hash = ${tokenHash}
      AND status IN ('sent', 'overdue')
    LIMIT 1
  `;
  return rows[0] || null;
}

async function loadBusinessMeta(workspaceId) {
  const { rows } = await sql`
    SELECT biz_name, slug FROM calendar_settings WHERE workspace_id = ${workspaceId}
  `;
  return rows[0] ? { name: rows[0].biz_name, slug: rows[0].slug } : null;
}

// Returns true when this workspace has Stripe wired up enough to accept a
// card payment from a public invoice viewer (secret + webhook secret both
// stored). Without webhook signing, paid invoices wouldn't auto-mark, so
// we hide the Pay button.
export async function isPaymentReady(workspaceId) {
  // Provider-aware: the public Pay button must show whenever the
  // workspace's ACTIVE processor can both take a payment AND auto-mark the
  // invoice paid via its webhook. Previously this only checked Stripe, so
  // Square/PayPal workspaces could send invoices their clients couldn't
  // pay online (even though /api/invoice-pay is fully provider-aware).
  const { rows } = await sql`
    SELECT payment_provider,
           stripe_connect_user_id, stripe_secret_encrypted, stripe_webhook_secret_encrypted,
           square_merchant_id, square_credentials_encrypted,
           paypal_merchant_id
      FROM finance_settings WHERE workspace_id = ${workspaceId} LIMIT 1
  `;
  if (rows.length === 0) return false;
  const fs = rows[0];
  switch (fs.payment_provider || 'stripe') {
    case 'square':
      return !!(fs.square_merchant_id && fs.square_credentials_encrypted);
    case 'paypal':
      return !!fs.paypal_merchant_id;
    case 'stripe':
    default:
      // Account-Links acct (auto-mark via platform webhook) OR legacy
      // Standard secret + per-workspace webhook secret.
      return !!(fs.stripe_connect_user_id
        || (fs.stripe_secret_encrypted && fs.stripe_webhook_secret_encrypted));
  }
}

export default async function handler(req, res) {
  try { await ensureSchemaApplied(); } catch { /* tolerate */ }
  if (req.method === 'GET')  return getInvoice(req, res);
  if (req.method === 'POST') return submitMarkPaid(req, res);
  return methodNotAllowed(res, ['GET', 'POST']);
}

async function getInvoice(req, res) {
  try {
    const ip = getClientIp(req);
    const blocked = await enforce(req, res, [
      { key: `invview-get:ip:${ip}`, max: 30, windowSeconds: 60 * 60 },
    ]);
    if (blocked) return;

    const token = (req.query.token || '').toString();
    const inv = await fetchByToken(token);
    if (!inv) return notFound(res, 'This invoice link is invalid, has expired, or was already paid.');

    // Self-heal: if this still-unpaid invoice has a completed Stripe
    // checkout session, mark it paid now rather than waiting on a webhook
    // that may never have been configured. Bounded (only invoices carrying
    // a cs_ session); no-op otherwise.
    if (await reconcileStripeInvoice(inv)) {
      return notFound(res, 'This invoice was already paid — thank you!');
    }

    // Append a 'viewed' activity once per day (best-effort).
    const activity = inv.activity || [];
    const last = activity[activity.length - 1];
    const lastIsViewToday = last && last.kind === 'viewed' &&
      (Date.now() - new Date(last.ts).getTime()) < 24 * 60 * 60 * 1000;
    if (!lastIsViewToday) {
      const next = [...activity, {
        ts: new Date().toISOString(),
        kind: 'viewed',
        text: `${inv.client_name || 'Recipient'} opened the invoice`,
      }];
      await sql`UPDATE invoices SET activity = ${JSON.stringify(next)}::jsonb WHERE id = ${inv.id}`;
    }

    const [business, paymentEnabled] = await Promise.all([
      loadBusinessMeta(inv.workspace_id),
      isPaymentReady(inv.workspace_id),
    ]);
    return ok(res, { invoice: serializeInvoicePublic(inv, { business, paymentEnabled }) });
  } catch (err) {
    return serverError(res, err);
  }
}

async function submitMarkPaid(req, res) {
  try {
    const ip = getClientIp(req);
    const blocked = await enforce(req, res, [
      { key: `invview-post:ip:${ip}`, max: 10, windowSeconds: 60 * 60 },
    ]);
    if (blocked) return;

    const token = (req.query.token || '').toString();
    const inv = await fetchByToken(token);
    if (!inv) return notFound(res, 'This invoice link is invalid or has expired.');

    const body = await readBody(req);
    const note = body.note ? String(body.note).slice(0, 280) : '';

    const newActivity = [
      ...(inv.activity || []),
      {
        ts: new Date().toISOString(),
        kind: 'client-marked-paid',
        text: `${inv.client_name || 'Recipient'} marked this invoice as paid${note ? ` — "${note}"` : ''}`,
      },
    ];
    await sql`
      UPDATE invoices SET activity = ${JSON.stringify(newActivity)}::jsonb WHERE id = ${inv.id}
    `;
    return ok(res, { ok: true });
  } catch (err) {
    return serverError(res, err);
  }
}
