// POST /api/finance/sync-stripe
//
// Retroactive reconciliation between the workspace's Stripe history
// and local invoices. The headline use case: an owner has been
// taking payments in Stripe but their THRYVE revenue tile shows $0
// (webhooks weren't configured, or were misconfigured for a stretch,
// or memberships ran before the renewal handler shipped). Hitting
// this endpoint walks Stripe history and brings the local DB into
// agreement.
//
// Two passes, both idempotent:
//   1. Checkout sessions with `payment_status='paid'` and a
//      `metadata.invoice_id` — match to local invoices, mark paid
//      with the same shape the webhook handler writes.
//   2. Stripe invoices with `status='paid'` tied to a subscription —
//      route through recordMembershipRenewal (idempotent on the
//      stripe invoice id) so subscription revenue lands as
//      source='membership' rows.
//
// Window: defaults to 90 days. Owners can pass `?days=N` (capped at
// 730) for a deeper backfill the first time. Pagination via
// starting_after; capped at 2000 records per pass to keep a single
// invocation bounded.
//
// Returns a report:
//   {
//     ok: true,
//     window: { days, sinceISO },
//     sessions:    { scanned, matched, marked_paid, already_paid, no_invoice_id, not_found },
//     invoices:    { scanned, created, already_recorded, no_membership, zero_amount },
//     errors: [{ where, message }],
//   }
import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { requireSameOrigin } from '../_lib/security.js';
import { loadStripeCreds } from '../_lib/stripeCreds.js';
import { listCheckoutSessions, listStripeInvoices } from '../_lib/stripe.js';
import { computeTotals } from '../_lib/finance.js';
import { recordMembershipRenewal } from '../_lib/membershipRevenue.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

const DEFAULT_DAYS = 90;
const MAX_DAYS = 730;
const HARD_RECORD_CAP = 2000; // per pass

function fmtMoney(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') return methodNotAllowed(res, ['POST', 'GET']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);

    const daysRaw = Number(req.query?.days);
    const days = Math.min(MAX_DAYS, Math.max(1, Number.isFinite(daysRaw) && daysRaw > 0 ? daysRaw : DEFAULT_DAYS));
    const sinceMs = Date.now() - days * 86400_000;

    let creds;
    try { creds = await loadStripeCreds(workspaceId); }
    catch (err) {
      if (err.code === 'no_stripe_connection') {
        return badRequest(res, 'Stripe is not connected for this workspace.');
      }
      if (err.code === 'platform_secret_missing') {
        return badRequest(res, 'Stripe platform key not configured on this deploy.');
      }
      if (err.code === 'stripe_credentials_invalid') {
        return badRequest(res, 'Saved Stripe credentials could not be decrypted. Disconnect and reconnect Stripe.');
      }
      return serverError(res, err);
    }

    const report = {
      ok: true,
      window: { days, sinceISO: new Date(sinceMs).toISOString() },
      sessions: { scanned: 0, matched: 0, marked_paid: 0, already_paid: 0, no_invoice_id: 0, not_found: 0 },
      invoices: { scanned: 0, created: 0, already_recorded: 0, no_membership: 0, zero_amount: 0 },
      errors: [],
    };

    // ─── Pass 1: Checkout sessions → invoices.paid ──────────────────
    {
      let startingAfter = null;
      let pages = 0;
      while (report.sessions.scanned < HARD_RECORD_CAP) {
        let page;
        try {
          // eslint-disable-next-line no-await-in-loop
          page = await listCheckoutSessions({
            secretKey: creds.secretKey,
            stripeAccount: creds.stripeAccount,
            sinceMs,
            startingAfter,
            limit: 100,
          });
        } catch (err) {
          report.errors.push({ where: 'list-checkout-sessions', message: err.message });
          break;
        }
        const rows = Array.isArray(page?.data) ? page.data : [];
        if (rows.length === 0) break;
        for (const session of rows) {
          report.sessions.scanned++;
          // eslint-disable-next-line no-await-in-loop
          await reconcileSession({ session, workspaceId, report });
        }
        if (!page.has_more) break;
        startingAfter = rows[rows.length - 1]?.id || null;
        if (!startingAfter) break;
        pages++;
        if (pages > 30) break; // 3000 records hard ceiling
      }
    }

    // ─── Pass 2: Stripe Invoices (subscription renewals) ────────────
    {
      let startingAfter = null;
      let pages = 0;
      while (report.invoices.scanned < HARD_RECORD_CAP) {
        let page;
        try {
          // eslint-disable-next-line no-await-in-loop
          page = await listStripeInvoices({
            secretKey: creds.secretKey,
            stripeAccount: creds.stripeAccount,
            sinceMs,
            startingAfter,
            limit: 100,
            status: 'paid',
          });
        } catch (err) {
          report.errors.push({ where: 'list-stripe-invoices', message: err.message });
          break;
        }
        const rows = Array.isArray(page?.data) ? page.data : [];
        if (rows.length === 0) break;
        for (const stripeInvoice of rows) {
          report.invoices.scanned++;
          // Only subscription invoices are membership revenue — skip
          // standalone Stripe Invoices (which THRYVE doesn't produce).
          if (!stripeInvoice.subscription) continue;
          try {
            // eslint-disable-next-line no-await-in-loop
            const r = await recordMembershipRenewal({ workspaceId, stripeInvoice });
            if (r.created) report.invoices.created++;
            else if (r.skipped === 'already-recorded') report.invoices.already_recorded++;
            else if (r.skipped === 'no-membership') report.invoices.no_membership++;
            else if (r.skipped === 'zero-amount') report.invoices.zero_amount++;
          } catch (err) {
            report.errors.push({ where: `invoice ${stripeInvoice.id}`, message: err.message });
          }
        }
        if (!page.has_more) break;
        startingAfter = rows[rows.length - 1]?.id || null;
        if (!startingAfter) break;
        pages++;
        if (pages > 30) break;
      }
    }

    return ok(res, report);
  } catch (err) {
    return serverError(res, err);
  }
}

// Marks a local invoice paid from a completed Stripe Checkout
// Session. Mirrors the shape the webhook handler writes (status,
// paid_at, paid_amount from session.amount_total, paid_method,
// stripe_payment_intent, stripe_session_id, view_token_hash cleared,
// activity entry). Guards with `AND status <> 'paid'` so re-running
// the sync never double-stamps.
async function reconcileSession({ session, workspaceId, report }) {
  if (session.payment_status !== 'paid' && session.status !== 'complete') {
    return; // not a completed payment
  }
  const invoiceId = session.metadata?.invoice_id;
  if (!invoiceId) {
    report.sessions.no_invoice_id++;
    return;
  }
  // Booking deposits and membership subscriptions ride different
  // paths — skip here so the sync is invoice-payment-only.
  if (typeof invoiceId === 'string' && invoiceId.startsWith('bookdep_')) {
    return;
  }
  if (session.mode === 'subscription' || session.mode === 'setup') {
    return;
  }

  const eventWorkspaceId = session.metadata?.workspace_id;
  if (eventWorkspaceId && eventWorkspaceId !== workspaceId) {
    // Cross-tenant session metadata — drop quietly. The connected
    // account is the workspace's, so this would be very unusual.
    return;
  }

  const inv = await sql`
    SELECT * FROM invoices
     WHERE id = ${invoiceId} AND workspace_id = ${workspaceId}
     LIMIT 1
  `;
  if (inv.rows.length === 0) {
    report.sessions.not_found++;
    return;
  }
  report.sessions.matched++;
  if (inv.rows[0].status === 'paid') {
    report.sessions.already_paid++;
    return;
  }

  const i = inv.rows[0];
  const totals = computeTotals(i.items || [], i.tax_rate, i.discount);
  const stripeAmountCents = Number(session.amount_total);
  const collectedAmount = Number.isFinite(stripeAmountCents) && stripeAmountCents > 0
    ? Math.round(stripeAmountCents) / 100
    : totals.total;
  const paymentIntent = typeof session.payment_intent === 'string'
    ? session.payment_intent
    : session.payment_intent?.id || null;

  const newActivity = [
    ...(i.activity || []),
    {
      ts: new Date().toISOString(),
      kind: 'paid',
      text: `Paid by card · ${fmtMoney(collectedAmount)} (reconciled from Stripe)`,
    },
  ];

  const upd = await sql`
    UPDATE invoices SET
      status = 'paid',
      paid_at = COALESCE(paid_at, to_timestamp(${session.created || Math.floor(Date.now() / 1000)})),
      paid_method = 'card',
      paid_amount = ${collectedAmount},
      stripe_payment_intent = ${paymentIntent},
      stripe_session_id = ${session.id},
      view_token_hash = NULL,
      activity = ${JSON.stringify(newActivity)}::jsonb,
      updated_at = NOW()
    WHERE id = ${i.id} AND workspace_id = ${workspaceId} AND status <> 'paid'
    RETURNING id
  `;
  if (upd.rows.length > 0) {
    report.sessions.marked_paid++;
  }
}
