// GET /api/businesses/:slug
// Public, no auth required for the basic info - same surface anyone
// browsing the public booking page can read. When called by a signed-in
// client, also returns review eligibility (has the user booked from
// or messaged this business → can they leave a review?).
//
// Powers the expanded card view in /me/discover. Returns:
//   • business - name, tagline, category, address, branding (logo +
//     accent), website handle for "Visit site"
//   • services - full list with name/price/duration/photo (sorted)
//   • reviews - { summary: { count, avg }, recent: [...] }
//   • eligibility - { canReview, hasReviewed, reason } when the caller
//     is a signed-in user; null otherwise.
import { sql } from '../../_lib/db.js';
import { readSession } from '../../_lib/auth.js';
import { enforce, getClientIp } from '../../_lib/rate-limit.js';
import { ensureSchemaApplied } from '../../_lib/ensureSchema.js';
import { serializeReview } from '../../_lib/reviews.js';
import { methodNotAllowed, notFound, ok, serverError } from '../../_lib/json.js';

// Non-throwing session reader. requireUser() 401s on missing session,
// which is wrong here - anonymous browsers should still be able to
// load the business detail; we just won't compute eligibility for them.
async function maybeUser(req) {
  const session = readSession(req);
  if (!session?.sub) return null;
  const { rows } = await sql`SELECT id, email FROM users WHERE id = ${session.sub} LIMIT 1`;
  return rows[0] || null;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    // Public - bypasses requireUser, so bootstrap the schema here on
    // cold-start so columns like websites.visibility / services.visibility
    // exist before the queries below run.
    await ensureSchemaApplied();
    const ip = getClientIp(req);
    const blocked = await enforce(req, res, [
      { key: `biz-detail:ip:${ip}`, max: 240, windowSeconds: 60 * 60 },
    ]);
    if (blocked) return;

    const slug = (req.query.slug || '').toString().toLowerCase();
    if (!slug) return notFound(res);

    // Pull business + branding + website handle + weekly availability
    // in one round-trip.
    const cs = await sql`
      SELECT
        cs.workspace_id, cs.slug, cs.biz_name, cs.tagline, cs.category,
        cs.address_label, cs.lat, cs.lng, cs.timezone, cs.availability,
        cs.brand_logo_url, cs.brand_accent_color, cs.brand_email_signature,
        w.handle AS website_handle, w.launched AS website_launched, w.visibility AS website_visibility
      FROM calendar_settings cs
      LEFT JOIN websites w ON w.workspace_id = cs.workspace_id
      WHERE cs.slug = ${slug} AND cs.discoverable = TRUE
    `;
    if (cs.rows.length === 0) return notFound(res, 'Business not found');
    const row = cs.rows[0];
    const workspaceId = row.workspace_id;

    // Services - only the publicly-listed ones for the Discover surface.
    // 'private' services exist but are intentionally not surfaced here
    // (clients with a direct link can still book them on /book/[slug]),
    // and 'only_me' services are hidden everywhere.
    const svcRows = await sql`
      SELECT id, name, description, duration_minutes, price, photo_url,
             display_order, location_type, location_label, capacity
      FROM services
      WHERE workspace_id = ${workspaceId} AND visibility = 'public'
      ORDER BY display_order ASC, price ASC
    `;

    // Reviews aggregate + recent 10 visible.
    const agg = await sql`
      SELECT COUNT(*)::int AS count, AVG(rating)::numeric AS avg
      FROM reviews WHERE workspace_id = ${workspaceId} AND status = 'visible'
    `;
    const recentReviews = await sql`
      SELECT * FROM reviews
      WHERE workspace_id = ${workspaceId} AND status = 'visible'
      ORDER BY created_at DESC LIMIT 10
    `;

    // Eligibility - only computed when the caller is a signed-in user.
    // A user can review when:
    //   1. They have a `clients` row in this workspace (matched by linked
    //      user_id OR by email), AND
    //   2. They have at least one booking in this workspace OR at least
    //      one message thread tied to that client_id (a thread is
    //      created by the first message, so its existence proves the
    //      client has messaged the owner).
    // …unless they've already reviewed this workspace, in which case
    // we surface that so the UI can hide the form.
    let eligibility = null;
    const me = await maybeUser(req);
    if (me) {
      const clientRows = await sql`
        SELECT id FROM clients
        WHERE workspace_id = ${workspaceId}
          AND (user_id = ${me.id} OR LOWER(email) = LOWER(${me.email}))
      `;
      const clientIds = clientRows.rows.map((r) => r.id);

      // Already-reviewed check - UNIQUE INDEX prevents the insert
      // anyway, but checking up-front lets the UI hide the form.
      const existing = await sql`
        SELECT id FROM reviews
        WHERE workspace_id = ${workspaceId} AND reviewer_user_id = ${me.id}
        LIMIT 1
      `;
      const hasReviewed = existing.rows.length > 0;

      let canReview = false;
      let reason = null;
      if (hasReviewed) {
        reason = 'already-reviewed';
      } else if (clientIds.length === 0) {
        reason = 'not-a-client';
      } else {
        const bookingHit = await sql`
          SELECT 1 FROM bookings
          WHERE workspace_id = ${workspaceId} AND client_id = ANY(${clientIds})
          LIMIT 1
        `;
        const threadHit = await sql`
          SELECT 1 FROM message_threads
          WHERE workspace_id = ${workspaceId} AND client_id = ANY(${clientIds})
          LIMIT 1
        `;
        if (bookingHit.rows.length > 0 || threadHit.rows.length > 0) {
          canReview = true;
        } else {
          reason = 'no-booking-or-message';
        }
      }
      // clientId surfaces the matched client row (when there is one)
      // so the Discover UI can hand it to /api/me/threads to start a
      // direct message thread without an extra round-trip.
      eligibility = {
        canReview, hasReviewed, reason,
        clientId: clientIds[0] || null,
      };
    }

    // Photo gallery - every distinct photo_url across the workspace's
    // PUBLIC services, ordered by display_order. The svcRows query
    // already filters visibility='public' so this inherits the cut.
    // Discover surfaces this as a horizontally-scrolling gallery in
    // the expanded card.
    const gallery = svcRows.rows
      .map((s) => s.photo_url)
      .filter((u, i, arr) => u && arr.indexOf(u) === i);

    return ok(res, {
      business: {
        slug:         row.slug,
        bizName:      row.biz_name,
        tagline:      row.tagline || '',
        category:     row.category || null,
        addressLabel: row.address_label || '',
        lat:          row.lat == null ? null : Number(row.lat),
        lng:          row.lng == null ? null : Number(row.lng),
        timezone:     row.timezone || null,
        // Weekday → array of { start, end } intervals in minutes-from-
        // midnight (workspace-local time). Same shape the public
        // booking page already consumes from /api/calendar/public.
        availability: row.availability || null,
        logoUrl:      row.brand_logo_url || null,
        accentColor:  row.brand_accent_color || null,
        // Site only surfaces here when it's both launched AND public.
        // Private sites stay reachable by direct /site/<handle> link.
        siteHandle:   (row.website_launched && row.website_visibility === 'public')
          ? row.website_handle : null,
        bookUrl:      `/book/${row.slug}`,
      },
      gallery,
      services: svcRows.rows.map((s) => ({
        id:               s.id,
        name:             s.name,
        description:      s.description || '',
        durationMinutes:  s.duration_minutes,
        price:            Number(s.price || 0),
        photoUrl:         s.photo_url || null,
        locationType:     s.location_type || 'in_person',
        locationLabel:    s.location_label || '',
        capacity:         s.capacity || 1,
      })),
      reviews: {
        summary: {
          count: agg.rows[0]?.count || 0,
          avg:   agg.rows[0]?.avg != null ? Number(agg.rows[0].avg) : null,
        },
        recent: recentReviews.rows.map((r) => serializeReview(r)),
      },
      eligibility,
    });
  } catch (err) {
    return serverError(res, err);
  }
}
