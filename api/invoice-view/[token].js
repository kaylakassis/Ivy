// /api/invoice-view/:token  (public, no auth)
//   GET   → public invoice payload (only if status='sent' or 'overdue')
//   POST  → optional "I've paid" confirmation. Doesn't actually settle the
//           invoice (real Stripe lands in phase B); records an activity entry
//           the owner sees, so they can reconcile.
//
// Token is sha256-hashed before lookup.
import { sql } from '../_lib/db.js';
import { readBody } from '../_lib/body.js';
import { enforce, getClientIp } from '../_lib/rate-limit.js';
import { serializeInvoicePublic } from '../_lib/finance.js';
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
async function isStripeReady(workspaceId) {
  // Account-Links workspaces don't set a per-workspace webhook secret —
  // their events flow through the platform-level webhook
  // (/api/webhooks/stripe-platform) using a single STRIPE_WEBHOOK_SECRET.
  // So the readiness check is:
  //
  //   • Account-Links acct exists  → ready (auto-mark via platform webhook)
  //   • Legacy Standard secret + per-workspace webhook secret → ready
  //   • Otherwise → not ready (hide the Pay button)
  const { rows } = await sql`
    SELECT 1 FROM finance_settings
    WHERE workspace_id = ${workspaceId}
      AND (
        stripe_connect_user_id IS NOT NULL
        OR (stripe_secret_encrypted IS NOT NULL AND stripe_webhook_secret_encrypted IS NOT NULL)
      )
    LIMIT 1
  `;
  return rows.length > 0;
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
      isStripeReady(inv.workspace_id),
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
