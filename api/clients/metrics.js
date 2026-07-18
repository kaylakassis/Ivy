// GET /api/clients/metrics
//   ?id=<clientId>   → single client metrics
//   ?all=1           → bulk metrics for every client in the workspace
//
// Surfaces the "at-a-glance" health numbers the Clients page + drawer
// need: sessions left across active packages, the most-imminent
// payment-due date (next membership renewal OR oldest unpaid invoice),
// the client's effective monthly payment from active memberships,
// and trailing-30-day paid-invoice revenue.
//
// Both endpoints return the same shape, just keyed differently:
//   single → { metrics: { sessionsLeft, dueDate, dueDateKind, monthlyPaymentCents, revenue30dCents, packagesExhausted } }
//   bulk   → { metrics: { [clientId]: { ...same fields } } }
//
// Lives at /api/clients/metrics (flat) rather than /api/clients/<id>/metrics
// because Vercel's file-based routing conflicts with the [id]/ folder.
// Same constraint as /api/clients/analytics.
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { requireSameOrigin } from '../_lib/security.js';
import { badRequest, methodNotAllowed, notFound, ok, serverError } from '../_lib/json.js';

// Normalize a per-period price into per-month cents.
// week × 4.345  | month × 1 | quarter ÷ 3 | year ÷ 12
function toMonthlyCents(priceCents, interval) {
  const p = Number(priceCents) || 0;
  switch (interval) {
    case 'week':    return Math.round(p * 4.345);
    case 'quarter': return Math.round(p / 3);
    case 'year':    return Math.round(p / 12);
    case 'month':
    default:        return p;
  }
}

// Compute metrics for one client given pre-fetched rows. Pulled out so
// the bulk path can run one query and split per client in JS.
function metricsFor({ packages, memberships, invoices, payments30d }) {
  // Sessions: sum of credits_remaining across active packages.
  let sessionsLeft = 0;
  let packagesExhausted = 0; // count of packages that just hit 0 / are exhausted
  for (const p of packages) {
    if (p.status === 'active') sessionsLeft += Number(p.credits_remaining || 0);
    if (p.status === 'exhausted') packagesExhausted++;
  }

  // Monthly payment: sum of active client_memberships normalized to /month.
  let monthlyPaymentCents = 0;
  let nextMembershipRenewal = null;
  for (const m of memberships) {
    if (m.status !== 'active' && m.status !== 'past_due') continue;
    monthlyPaymentCents += toMonthlyCents(m.price_cents, m.interval);
    if (m.current_period_end) {
      const d = new Date(m.current_period_end);
      if (!nextMembershipRenewal || d < nextMembershipRenewal) {
        nextMembershipRenewal = d;
      }
    }
  }

  // Oldest unpaid invoice with a due date.
  let earliestInvoiceDue = null;
  for (const inv of invoices) {
    if (!inv.due_date) continue;
    const d = inv.due_date instanceof Date ? inv.due_date : new Date(inv.due_date);
    if (!earliestInvoiceDue || d < earliestInvoiceDue) earliestInvoiceDue = d;
  }

  // Pick the soonest of the two - that's what the owner needs to act on first.
  let dueDate = null;
  let dueDateKind = null; // 'invoice' | 'membership' | null
  if (earliestInvoiceDue && nextMembershipRenewal) {
    if (earliestInvoiceDue <= nextMembershipRenewal) {
      dueDate = earliestInvoiceDue; dueDateKind = 'invoice';
    } else {
      dueDate = nextMembershipRenewal; dueDateKind = 'membership';
    }
  } else if (earliestInvoiceDue) {
    dueDate = earliestInvoiceDue; dueDateKind = 'invoice';
  } else if (nextMembershipRenewal) {
    dueDate = nextMembershipRenewal; dueDateKind = 'membership';
  }

  // 30-day revenue: sum paid_amount from invoices paid in the last 30 days.
  let revenue30dCents = 0;
  for (const p of payments30d) {
    revenue30dCents += Math.round(Number(p.paid_amount || 0) * 100);
  }

  return {
    sessionsLeft,
    packagesExhausted,
    dueDate: dueDate ? dueDate.toISOString() : null,
    dueDateKind,
    monthlyPaymentCents,
    revenue30dCents,
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;

    const id = (req.query.id || '').toString();
    const wantAll = req.query.all === '1' || req.query.all === 'true';

    if (!wantAll && !id) return badRequest(res, 'Pass ?id=<clientId> or ?all=1');

    // Build the client-id filter once so single + bulk share the same
    // queries. For single mode we also verify ownership before doing work.
    let clientIds;
    if (id) {
      const c = await sql`
        SELECT id FROM clients WHERE id = ${id} AND workspace_id = ${workspaceId}
      `;
      if (c.rows.length === 0) return notFound(res, 'Client not found');
      clientIds = [id];
    } else {
      const c = await sql`
        SELECT id FROM clients WHERE workspace_id = ${workspaceId}
      `;
      clientIds = c.rows.map((r) => r.id);
    }

    if (clientIds.length === 0) {
      return ok(res, wantAll ? { metrics: {} } : { metrics: zeroMetrics() });
    }

    // Pull every needed row in three queries (not per-client). Each
    // query is workspace-scoped + client_id IN (...) so a tenancy bug
    // can't leak data across workspaces.
    //
    // Tolerate partial schema: client_memberships / client_packages
    // may not exist on older deploys. Catch and treat as empty arrays.
    let packages = [];
    try {
      const r = await sql.query(
        `SELECT id, client_id, status, credits_remaining
         FROM client_packages
         WHERE workspace_id = $1 AND client_id = ANY($2::uuid[])`,
        [workspaceId, clientIds],
      );
      packages = r.rows;
    } catch (e) {
      console.error('[clients/metrics] packages query failed (continuing):', e.message);
    }

    let memberships = [];
    try {
      const r = await sql.query(
        `SELECT id, client_id, status, price_cents, interval, current_period_end
         FROM client_memberships
         WHERE workspace_id = $1 AND client_id = ANY($2::uuid[])`,
        [workspaceId, clientIds],
      );
      memberships = r.rows;
    } catch (e) {
      console.error('[clients/metrics] memberships query failed (continuing):', e.message);
    }

    // Unpaid invoices with due dates. 'sent' and 'overdue' are both
    // "owed but not paid" (the invoice-overdue cron flips sent→overdue
    // once the due date passes). 'draft'/'voided'/'paid'/'refunded'
    // excluded.
    let invoices = [];
    try {
      const r = await sql.query(
        `SELECT id, client_id, due_date
         FROM invoices
         WHERE workspace_id = $1 AND client_id = ANY($2::uuid[])
           AND status IN ('sent', 'overdue') AND due_date IS NOT NULL`,
        [workspaceId, clientIds],
      );
      invoices = r.rows;
    } catch (e) {
      console.error('[clients/metrics] invoices query failed (continuing):', e.message);
    }

    // Paid invoices in the last 30 days.
    let payments30d = [];
    try {
      const r = await sql.query(
        `SELECT id, client_id, paid_amount
         FROM invoices
         WHERE workspace_id = $1 AND client_id = ANY($2::uuid[])
           AND status = 'paid'
           AND paid_at >= NOW() - INTERVAL '30 days'`,
        [workspaceId, clientIds],
      );
      payments30d = r.rows;
    } catch (e) {
      console.error('[clients/metrics] payments30d query failed (continuing):', e.message);
    }

    // Split per client in JS - one pass each.
    const byClient = {};
    for (const cid of clientIds) {
      byClient[cid] = {
        packages: [], memberships: [], invoices: [], payments30d: [],
      };
    }
    for (const p of packages)    byClient[p.client_id]?.packages.push(p);
    for (const m of memberships) byClient[m.client_id]?.memberships.push(m);
    for (const inv of invoices)  byClient[inv.client_id]?.invoices.push(inv);
    for (const p of payments30d) byClient[p.client_id]?.payments30d.push(p);

    if (wantAll) {
      const out = {};
      for (const cid of clientIds) out[cid] = metricsFor(byClient[cid]);
      return ok(res, { metrics: out });
    }
    return ok(res, { metrics: metricsFor(byClient[id]) });
  } catch (err) {
    return serverError(res, err);
  }
}

function zeroMetrics() {
  return {
    sessionsLeft: 0, packagesExhausted: 0,
    dueDate: null, dueDateKind: null,
    monthlyPaymentCents: 0, revenue30dCents: 0,
  };
}
