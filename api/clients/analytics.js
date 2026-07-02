// GET /api/clients/analytics?id=<clientId>&windowDays=<n>
//
// Per-client analytics computed on the fly. Used by ClientDrawer to
// surface show rate, total bookings, signed-document count, etc.
// Computed at read time so the numbers always reflect the freshest
// state - no separate stats table to keep in sync.
//
// windowDays (optional, default 30, min 1, max 3650). When supplied,
// every booking-derived metric is restricted to bookings whose date
// falls within the trailing window. Signed documents are not windowed
// (the lifetime list is the useful surface for "what have they
// signed?"). Pass 0 / negative / "all" / leave unset → defaults apply.
//
// Lives at /api/clients/analytics rather than /api/clients/<id>/analytics
// because Vercel's file-based routing treats /api/clients/[id].js and a
// parametric folder /api/clients/[id]/... as a conflict.
//
// Returned shape (all fields nullable when there's no data yet):
//   {
//     totalBookings, completedBookings, noShowBookings, cancelledBookings,
//     showRate (0..1 | null),
//     firstBookingAt, lastBookingAt,
//     averageDaysBetweenBookings,
//     totalRevenue,
//     averageBookingValue,
//     signedDocumentsCount, signedDocuments: [{ id, name, signedAt }],
//   }
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { workspaceTimeZone } from '../_lib/calendar.js';
import { requireSameOrigin } from '../_lib/security.js';
import { badRequest, methodNotAllowed, notFound, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;

    const id = (req.query.id || '').toString();
    if (!id) return badRequest(res, 'Missing client id');

    const cl = await sql`
      SELECT id FROM clients WHERE id = ${id} AND workspace_id = ${workspaceId}
    `;
    if (cl.rows.length === 0) return notFound(res, 'Client not found');

    // Window: clamp to [1, 3650]. 0/negative/missing/'all' → unrestricted
    // (we use 100k days, effectively lifetime). Sent by the Clients page
    // as the user-selected conversion/churn window so per-client metrics
    // share the same time horizon as the page-level rollups.
    const windowRaw = req.query.windowDays;
    let windowDays = null;
    if (windowRaw != null && windowRaw !== '' && String(windowRaw).toLowerCase() !== 'all') {
      const n = Number(windowRaw);
      if (Number.isFinite(n) && n >= 1) {
        windowDays = Math.min(3650, Math.floor(n));
      }
    }

    // The trailing window and the "already happened" check both resolve
    // against the owner's timezone, not the server's UTC.
    const tz = await workspaceTimeZone(workspaceId);

    // Bookings rollup + signed documents fired in parallel — neither
    // depends on the other. Cuts client-drawer load latency roughly in
    // half on a cold function instance. The conditional per-booking
    // `dates` query below still has to wait for the agg result (it's
    // gated on totalBookings >= 3) so it remains sequential.
    const aggQuery = windowDays
      ? sql`
          SELECT
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE no_show_at IS NOT NULL)::int AS no_shows,
            COUNT(*) FILTER (WHERE cancelled_at IS NOT NULL)::int AS cancelled,
            COUNT(*) FILTER (
              WHERE no_show_at IS NULL
                AND cancelled_at IS NULL
                AND ((date + (end_min || ' minutes')::interval) AT TIME ZONE ${tz}) < NOW()
            )::int AS completed,
            MIN(date) AS first_at,
            MAX(date) AS last_at,
            SUM(booking_total)::numeric AS total_revenue
          FROM bookings
          WHERE workspace_id = ${workspaceId} AND client_id = ${id}
            AND date >= ((NOW() AT TIME ZONE ${tz})::date - (${windowDays}::int || ' days')::interval)
        `
      : sql`
          SELECT
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE no_show_at IS NOT NULL)::int AS no_shows,
            COUNT(*) FILTER (WHERE cancelled_at IS NOT NULL)::int AS cancelled,
            COUNT(*) FILTER (
              WHERE no_show_at IS NULL
                AND cancelled_at IS NULL
                AND ((date + (end_min || ' minutes')::interval) AT TIME ZONE ${tz}) < NOW()
            )::int AS completed,
            MIN(date) AS first_at,
            MAX(date) AS last_at,
            SUM(booking_total)::numeric AS total_revenue
          FROM bookings
          WHERE workspace_id = ${workspaceId} AND client_id = ${id}
        `;
    const docsQuery = sql`
      SELECT id, name, signed_at FROM (
        SELECT d.id, d.name, d.completed_at AS signed_at
        FROM documents d
        WHERE d.workspace_id = ${workspaceId}
          AND d.recipient_client_id = ${id}
          AND d.status = 'completed'
          AND d.completed_at IS NOT NULL
        UNION
        SELECT d.id, d.name, ds.signed_at
        FROM documents d
        JOIN document_signers ds ON ds.document_id = d.id
        WHERE d.workspace_id = ${workspaceId}
          AND ds.client_id = ${id}
          AND ds.signed_at IS NOT NULL
      ) merged
      ORDER BY signed_at DESC
      LIMIT 50
    `;
    const [aggRes, docsRes] = await Promise.all([aggQuery, docsQuery]);
    const agg = aggRes.rows;
    const docs = docsRes.rows;
    const a = agg[0] || {};
    const totalBookings    = a.total || 0;
    const noShowBookings   = a.no_shows || 0;
    const cancelledBookings = a.cancelled || 0;
    const completedBookings = a.completed || 0;
    // Show rate = completed / (completed + no_show). Cancellations
    // don't count against you; most owners reschedule them. NULL when
    // there aren't enough data points to mean anything (< 2 events).
    const showRateDenom = completedBookings + noShowBookings;
    const showRate = showRateDenom >= 2 ? completedBookings / showRateDenom : null;

    // Average days between bookings - proxy for cadence. Only computed
    // with 3+ non-cancelled bookings so a one-off doesn't trick owners
    // into reading too much into a single gap.
    let averageDaysBetweenBookings = null;
    if (totalBookings >= 3) {
      const { rows: dates } = await sql`
        SELECT date FROM bookings
        WHERE workspace_id = ${workspaceId} AND client_id = ${id}
          AND cancelled_at IS NULL
        ORDER BY date ASC
      `;
      const ts = dates.map((r) => new Date(r.date).getTime()).filter(Number.isFinite);
      if (ts.length >= 2) {
        let sumDelta = 0;
        for (let i = 1; i < ts.length; i++) sumDelta += (ts[i] - ts[i - 1]);
        averageDaysBetweenBookings = Math.round(
          (sumDelta / (ts.length - 1)) / (24 * 60 * 60 * 1000),
        );
      }
    }

    // (Signed-documents query is now part of the Promise.all above so
    // it runs alongside the bookings agg — saves a round-trip.)

    return ok(res, {
      totalBookings,
      completedBookings,
      noShowBookings,
      cancelledBookings,
      showRate,
      firstBookingAt: a.first_at || null,
      lastBookingAt:  a.last_at  || null,
      averageDaysBetweenBookings,
      totalRevenue: Number(a.total_revenue || 0),
      averageBookingValue: completedBookings > 0
        ? Math.round((Number(a.total_revenue || 0) / completedBookings) * 100) / 100
        : 0,
      signedDocumentsCount: docs.length,
      signedDocuments: docs.map((d) => ({
        id: d.id, name: d.name, signedAt: d.signed_at,
      })),
    });
  } catch (err) {
    return serverError(res, err);
  }
}
