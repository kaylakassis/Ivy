// GET /api/admin/users/:id/metrics
//
// Per-workspace summary for the super-admin: counts, sums, and ratios.
// PRIVACY CONTRACT — by design, this endpoint returns ZERO data that
// could identify the workspace's own clients:
//   • no client names, emails, phone numbers
//   • no invoice line items, document content, message text
//   • no notes / personal observations
// Only aggregates the super-admin needs to (a) measure how the platform
// is helping the owner and (b) triage support cases efficiently.
//
// Lives at api/admin/users/[id]/metrics.js so its URL slots cleanly under
// the existing /api/admin/users/[id] PATCH endpoint without overloading
// either file.
import { sql } from '../../../_lib/db.js';
import { requireSameOrigin } from '../../../_lib/security.js';
import { requireSuperAdmin } from '../../../_lib/admin.js';
import { methodNotAllowed, notFound, ok, serverError } from '../../../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!requireSameOrigin(req, res)) return;
  if (!(await requireSuperAdmin(req, res))) return;

  try {
    const { id } = req.query;
    if (!id) return notFound(res, 'User not found');

    // Resolve the user → workspace mapping. Owners have a workspace;
    // client-only users don't, in which case there's nothing to report.
    const userRow = await sql`
      SELECT u.id, u.email, u.created_at, u.email_verified_at,
             u.user_type, u.deleted_at,
             w.id AS workspace_id, w.created_at AS workspace_created_at,
             w.subscription_status, w.trial_ends_at,
             w.subscription_period_end, w.onboarded_at
        FROM users u
        LEFT JOIN workspaces w ON w.owner_id = u.id
       WHERE u.id = ${id}
       LIMIT 1
    `;
    if (userRow.rows.length === 0) return notFound(res, 'User not found');
    const row = userRow.rows[0];
    const wsId = row.workspace_id;
    if (!wsId) {
      return ok(res, {
        user: {
          id: row.id, email: row.email,
          createdAt: row.created_at,
          emailVerifiedAt: row.email_verified_at,
          userType: row.user_type,
          deletedAt: row.deleted_at,
        },
        workspace: null,
        message: 'This account has no business workspace — they sign in to the client portal only.',
      });
    }

    // Parallel aggregate queries — none return PII. Every WHERE clause
    // scopes by workspace_id so a single workspace's data is read.
    const [
      clientsCount,
      bookingsAll, bookings30d, bookings90d, bookingsNoShow, bookingsCancelled,
      bookingsCompleted, bookingsUpcoming,
      invoicesAll, invoicesPaid, invoicesSent, invoicesOverdue,
      revAllTime, rev30d, rev90d,
      documentsAll, documentsCompleted,
      workflowsAll, workflowsEnabled,
      reviewsAgg,
      messageThreadsCount,
      lastActivity,
    ] = await Promise.all([
      sql`SELECT COUNT(*)::int AS n FROM clients WHERE workspace_id = ${wsId}`,
      sql`SELECT COUNT(*)::int AS n FROM bookings WHERE workspace_id = ${wsId}`,
      sql`SELECT COUNT(*)::int AS n FROM bookings
           WHERE workspace_id = ${wsId} AND date >= CURRENT_DATE - INTERVAL '30 days'`,
      sql`SELECT COUNT(*)::int AS n FROM bookings
           WHERE workspace_id = ${wsId} AND date >= CURRENT_DATE - INTERVAL '90 days'`,
      sql`SELECT COUNT(*)::int AS n FROM bookings
           WHERE workspace_id = ${wsId} AND no_show_at IS NOT NULL`,
      sql`SELECT COUNT(*)::int AS n FROM bookings
           WHERE workspace_id = ${wsId} AND cancelled_at IS NOT NULL`,
      sql`SELECT COUNT(*)::int AS n FROM bookings
           WHERE workspace_id = ${wsId}
             AND completion_log IS NOT NULL
             AND completion_log::text <> '{}'`,
      sql`SELECT COUNT(*)::int AS n FROM bookings
           WHERE workspace_id = ${wsId}
             AND cancelled_at IS NULL
             AND date >= CURRENT_DATE`,
      sql`SELECT COUNT(*)::int AS n FROM invoices WHERE workspace_id = ${wsId}`,
      sql`SELECT COUNT(*)::int AS n FROM invoices WHERE workspace_id = ${wsId} AND status = 'paid'`,
      sql`SELECT COUNT(*)::int AS n FROM invoices WHERE workspace_id = ${wsId} AND status = 'sent'`,
      sql`SELECT COUNT(*)::int AS n FROM invoices
           WHERE workspace_id = ${wsId}
             AND status = 'sent'
             AND due_date IS NOT NULL
             AND due_date < CURRENT_DATE`,
      sql`SELECT COALESCE(SUM(total - COALESCE(refunded_amount, 0)), 0)::numeric AS total
           FROM invoices WHERE workspace_id = ${wsId} AND status = 'paid'`,
      sql`SELECT COALESCE(SUM(total - COALESCE(refunded_amount, 0)), 0)::numeric AS total
           FROM invoices WHERE workspace_id = ${wsId} AND status = 'paid'
             AND paid_at >= NOW() - INTERVAL '30 days'`,
      sql`SELECT COALESCE(SUM(total - COALESCE(refunded_amount, 0)), 0)::numeric AS total
           FROM invoices WHERE workspace_id = ${wsId} AND status = 'paid'
             AND paid_at >= NOW() - INTERVAL '90 days'`,
      sql`SELECT COUNT(*)::int AS n FROM documents
           WHERE workspace_id = ${wsId} AND is_template = FALSE`,
      sql`SELECT COUNT(*)::int AS n FROM documents
           WHERE workspace_id = ${wsId} AND status = 'completed'`,
      sql`SELECT COUNT(*)::int AS n FROM workflows WHERE workspace_id = ${wsId}`,
      sql`SELECT COUNT(*)::int AS n FROM workflows WHERE workspace_id = ${wsId} AND enabled = TRUE`,
      sql`SELECT COUNT(*)::int                       AS count,
                 COALESCE(AVG(rating)::numeric(3,2), 0) AS avg_rating
            FROM reviews
           WHERE workspace_id = ${wsId} AND published_at IS NOT NULL`,
      // Count only — no message text, no client identities.
      sql`SELECT COUNT(*)::int AS n FROM message_threads WHERE workspace_id = ${wsId}`,
      // Cheapest recency signal — last booking edit OR last invoice
      // edit OR last message in the workspace. UNION across the
      // candidates and take MAX so the figure reflects real activity
      // rather than just one table's freshness.
      sql`SELECT MAX(ts) AS ts FROM (
            SELECT MAX(updated_at) AS ts FROM bookings WHERE workspace_id = ${wsId}
            UNION ALL
            SELECT MAX(updated_at) FROM invoices WHERE workspace_id = ${wsId}
            UNION ALL
            SELECT MAX(last_message_at) FROM message_threads WHERE workspace_id = ${wsId}
          ) recent`,
    ]);

    // Derive ratios.
    const bkAll = bookingsAll.rows[0]?.n || 0;
    const noShows = bookingsNoShow.rows[0]?.n || 0;
    const cancelled = bookingsCancelled.rows[0]?.n || 0;
    const completed = bookingsCompleted.rows[0]?.n || 0;
    const noShowPct = bkAll > 0 ? Math.round((noShows / bkAll) * 1000) / 10 : 0;
    const cancellationPct = bkAll > 0 ? Math.round((cancelled / bkAll) * 1000) / 10 : 0;
    const completionPct = bkAll > 0 ? Math.round((completed / bkAll) * 1000) / 10 : 0;

    const invAll = invoicesAll.rows[0]?.n || 0;
    const invPaid = invoicesPaid.rows[0]?.n || 0;
    const paidInvoicePct = invAll > 0 ? Math.round((invPaid / invAll) * 1000) / 10 : 0;

    const revenueAllTime = Number(revAllTime.rows[0]?.total || 0);
    const avgBookingValue = bkAll > 0 ? Math.round((revenueAllTime / bkAll) * 100) / 100 : 0;

    return ok(res, {
      user: {
        id: row.id, email: row.email,
        createdAt: row.created_at,
        emailVerifiedAt: row.email_verified_at,
        userType: row.user_type,
        deletedAt: row.deleted_at,
      },
      workspace: {
        id: wsId,
        createdAt: row.workspace_created_at,
        subscriptionStatus: row.subscription_status,
        trialEndsAt: row.trial_ends_at,
        periodEnd: row.subscription_period_end,
        onboardedAt: row.onboarded_at,
      },
      counts: {
        clients:  clientsCount.rows[0]?.n || 0,
        bookings: {
          all:       bkAll,
          last30d:   bookings30d.rows[0]?.n || 0,
          last90d:   bookings90d.rows[0]?.n || 0,
          noShows,
          cancelled,
          completed,
          upcoming:  bookingsUpcoming.rows[0]?.n || 0,
        },
        invoices: {
          all:     invAll,
          paid:    invPaid,
          sent:    invoicesSent.rows[0]?.n || 0,
          overdue: invoicesOverdue.rows[0]?.n || 0,
        },
        documents: {
          all:       documentsAll.rows[0]?.n || 0,
          completed: documentsCompleted.rows[0]?.n || 0,
        },
        workflows: {
          total:   workflowsAll.rows[0]?.n || 0,
          enabled: workflowsEnabled.rows[0]?.n || 0,
        },
        reviews: {
          count:     reviewsAgg.rows[0]?.count || 0,
          avgRating: Math.round(Number(reviewsAgg.rows[0]?.avg_rating || 0) * 100) / 100,
        },
        messageThreads: messageThreadsCount.rows[0]?.n || 0,
      },
      revenue: {
        allTime:         revenueAllTime,
        last30d:         Number(rev30d.rows[0]?.total || 0),
        last90d:         Number(rev90d.rows[0]?.total || 0),
        avgBookingValue,
      },
      rates: {
        noShowPct,
        cancellationPct,
        completionPct,
        paidInvoicePct,
      },
      lastActivity: lastActivity.rows[0]?.ts || null,
      privacyNote: 'Aggregates only. No client identities, message text, document content, or note text crosses this endpoint by design.',
    });
  } catch (err) {
    return serverError(res, err);
  }
}
