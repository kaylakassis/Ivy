// GET /api/me/invoices - list every invoice tied to the user's client
// records. Money math (totals incl. tax/discount) is computed in SQL so
// the client just renders.
//
// Also returns lightweight aggregates used by the payments-tab header:
//   joinedAt           - earliest "member since" date across businesses
//   nextBooking        - soonest future booking with service + biz info
//   lastBookingBizSlug - most recent booking's biz slug, for the rebook
//                        CTA when there is no upcoming session
//   activePackage      - first non-expired package with credits remaining
//   activeMembership   - first active/past-due/incomplete membership
//   sessionsThisYear   - count of completed (non-cancelled, past) bookings
//                        in the current calendar year
//
// Each aggregate is wrapped in its own try/catch and falls back to a
// neutral value (null / 0) so a partial schema or single broken row
// can't 500 the whole payments tab.
import { sql } from '../../_lib/db.js';
import { requireUser } from '../../_lib/auth.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { myClientIds, ids } from '../../_lib/clientPortal.js';
import { serializeClientPackage } from '../../_lib/packages.js';
import { serializeClientMembership } from '../../_lib/memberships.js';
import { methodNotAllowed, ok, serverError } from '../../_lib/json.js';

// Defensive: every aggregate runs in parallel but a single failure
// degrades to a neutral value rather than failing the whole response.
// The payments tab is allowed to show "I don't know" but is NOT allowed
// to disappear because one optional query died.
async function safe(p, fallback) {
  try { return await p; } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[me/invoices] aggregate query failed:', e.message);
    return fallback;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const memberships = await myClientIds(user);
    const myIds = ids(memberships);
    if (myIds.length === 0) {
      return ok(res, {
        invoices: [],
        joinedAt: null,
        nextBooking: null,
        lastBookingBizSlug: null,
        activePackage: null,
        activeMembership: null,
        sessionsThisYear: 0,
      });
    }

    const byClient = new Map(memberships.map((m) => [m.clientId, m]));

    let rows;
    try { ({ rows } = await sql.query(
      `SELECT i.id, i.client_id, i.number, i.status,
              i.issue_date, i.due_date, i.paid_at,
              GREATEST(
                (SELECT COALESCE(SUM((it->>'quantity')::numeric * (it->>'rate')::numeric), 0)
                  FROM jsonb_array_elements(i.items) AS it) - i.discount,
                0
              ) * (1 + i.tax_rate / 100) AS total,
              i.tax_rate, i.discount
       FROM invoices i
       WHERE i.client_id = ANY($1)
         AND i.status <> 'draft'
       ORDER BY i.issue_date DESC, i.created_at DESC
       LIMIT 500`,
      [myIds],
    )); } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[me/invoices] query failed (returning empty):', e.message);
      return ok(res, {
        invoices: [],
        joinedAt: null,
        nextBooking: null,
        lastBookingBizSlug: null,
        activePackage: null,
        activeMembership: null,
        sessionsThisYear: 0,
      });
    }

    const invoices = rows.map((r) => {
      const m = byClient.get(r.client_id);
      return {
        id: r.id,
        number: r.number,
        status: r.status,
        issueDate: r.issue_date instanceof Date ? r.issue_date.toISOString().slice(0, 10) : r.issue_date,
        dueDate:   r.due_date   instanceof Date ? r.due_date.toISOString().slice(0, 10)   : r.due_date,
        paidAt:    r.paid_at,
        total:     Number(r.total || 0),
        businessName: m?.businessName || 'Business',
      };
    });

    // Five aggregates in parallel - same DB connection tolerates this
    // fine via Neon's pooled driver, and serial-awaiting them would
    // add ~5 round-trips to a request the user is staring at.
    const [
      joinedRows,
      nextBookingRows,
      lastBookingRows,
      pkgRows,
      membRows,
      sessionsCountRows,
    ] = await Promise.all([
      safe(sql.query(
        `SELECT MIN(joined_at) AS joined_at FROM clients WHERE id = ANY($1)`,
        [myIds],
      ), { rows: [] }),
      safe(sql.query(
        // Soonest future, non-cancelled booking. We sort by (date, start_min)
        // so same-day sessions order by time too. LEFT JOIN service +
        // calendar_settings so we can show "Deep tissue · Thu Jun 12 ·
        // Maple Massage" + link to /book/<slug>.
        `SELECT b.client_id, b.date, b.start_min, s.name AS service_name,
                cs.slug AS biz_slug
           FROM bookings b
           LEFT JOIN services s ON s.id = b.service_id AND s.workspace_id = b.workspace_id
           LEFT JOIN calendar_settings cs ON cs.workspace_id = b.workspace_id
          WHERE b.client_id = ANY($1)
            AND b.cancelled_at IS NULL
            AND b.date >= CURRENT_DATE
          ORDER BY b.date ASC, b.start_min ASC
          LIMIT 1`,
        [myIds],
      ), { rows: [] }),
      safe(sql.query(
        // Most recent booking (past or upcoming) - used to target the
        // rebook CTA at the right business when there's no upcoming
        // session. Falls back to NULL gracefully.
        `SELECT cs.slug AS biz_slug
           FROM bookings b
           LEFT JOIN calendar_settings cs ON cs.workspace_id = b.workspace_id
          WHERE b.client_id = ANY($1)
            AND b.cancelled_at IS NULL
          ORDER BY b.date DESC, b.start_min DESC
          LIMIT 1`,
        [myIds],
      ), { rows: [] }),
      safe(sql.query(
        // First active package - same filter the /api/me/packages list
        // uses, just LIMIT 1 for the metric tile.
        `SELECT * FROM client_packages
          WHERE client_id = ANY($1)
            AND status = 'active'
            AND credits_remaining > 0
            AND (expires_at IS NULL OR expires_at > NOW())
          ORDER BY created_at DESC
          LIMIT 1`,
        [myIds],
      ), { rows: [] }),
      safe(sql.query(
        // First non-cancelled membership. Same statuses /api/me/memberships
        // surfaces (active / past_due / incomplete) so the tile shows
        // anything the user is currently paying for or about to be
        // dunned on, which is the right thing for the value tile.
        `SELECT * FROM client_memberships
          WHERE client_id = ANY($1)
            AND status IN ('active', 'past_due', 'incomplete')
          ORDER BY started_at DESC
          LIMIT 1`,
        [myIds],
      ), { rows: [] }),
      safe(sql.query(
        // Count of past (already-happened, non-cancelled) bookings this
        // calendar year. The < CURRENT_DATE guard excludes future ones
        // even though they'd technically be in the same year - "Sessions
        // this year" means "you've already had this many."
        `SELECT COUNT(*)::int AS n
           FROM bookings
          WHERE client_id = ANY($1)
            AND cancelled_at IS NULL
            AND date >= DATE_TRUNC('year', CURRENT_DATE)
            AND date < CURRENT_DATE`,
        [myIds],
      ), { rows: [] }),
    ]);

    const joinedAt = joinedRows.rows?.[0]?.joined_at || null;
    const nextBookingRow = nextBookingRows.rows?.[0] || null;
    const nextBooking = nextBookingRow ? {
      date:         nextBookingRow.date instanceof Date
                      ? nextBookingRow.date.toISOString().slice(0, 10)
                      : nextBookingRow.date,
      startMin:     nextBookingRow.start_min,
      serviceName:  nextBookingRow.service_name || null,
      bizSlug:      nextBookingRow.biz_slug || null,
      businessName: byClient.get(nextBookingRow.client_id)?.businessName || 'Business',
    } : null;
    const lastBookingBizSlug = lastBookingRows.rows?.[0]?.biz_slug || null;
    const pkgRow = pkgRows.rows?.[0] || null;
    const activePackage = pkgRow ? {
      ...serializeClientPackage(pkgRow),
      businessName: byClient.get(pkgRow.client_id)?.businessName || 'Business',
    } : null;
    const membRow = membRows.rows?.[0] || null;
    const activeMembership = membRow ? {
      ...serializeClientMembership(membRow),
      businessName: byClient.get(membRow.client_id)?.businessName || 'Business',
    } : null;
    const sessionsThisYear = sessionsCountRows.rows?.[0]?.n || 0;

    return ok(res, {
      invoices,
      joinedAt,
      nextBooking,
      lastBookingBizSlug,
      activePackage,
      activeMembership,
      sessionsThisYear,
    });
  } catch (err) {
    return serverError(res, err);
  }
}
