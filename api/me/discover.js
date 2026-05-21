// GET /api/me/discover — public directory of businesses that have opted
// in to be listed (calendar_settings.discoverable = TRUE) AND have
// published a slug.
//
// Filter params (all optional, all compose):
//   q          string     name / tagline / service-name search ("botox")
//   category   string     Wellness | Beauty | Fitness | Health | Professional
//   priceMin   number     cheapest matched service ≥ priceMin (USD)
//   priceMax   number     cheapest matched service ≤ priceMax
//   lat / lng  number     anchor point for distance search (decimal degrees)
//   radiusKm   number     within this radius from lat/lng (haversine)
//
// Service search and price filter compose: priceMin/priceMax bound the
// SAME service that matches q, so "botox at $10–100" returns businesses
// whose botox is in that range — not businesses with botox AND something
// else in the range.
//
// Distance is computed in SQL via the haversine formula. Businesses
// without lat/lng are excluded from distance-bounded queries; without
// distance bounds, all businesses match regardless of coords.
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { requireSameOrigin } from '../_lib/security.js';
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';

function num(v, { min, max } = {}) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (min != null && n < min) return null;
  if (max != null && n > max) return null;
  return n;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const q        = (req.query.q || '').toString().trim();
    const category = (req.query.category || '').toString().trim();
    const priceMin = num(req.query.priceMin, { min: 0, max: 1e7 });
    const priceMax = num(req.query.priceMax, { min: 0, max: 1e7 });
    const lat       = num(req.query.lat, { min: -90, max: 90 });
    const lng       = num(req.query.lng, { min: -180, max: 180 });
    const radiusKm  = num(req.query.radiusKm, { min: 0.1, max: 20000 });
    const minRating = num(req.query.minRating, { min: 1, max: 5 });

    // ILIKE wildcard. Empty q ⇒ match anything (we drop the predicate).
    const qPattern = q ? `%${q.replace(/[%_]/g, (c) => '\\' + c)}%` : null;

    // The service filter only fires when the request actually scopes by
    // service-name OR price. Without either, we don't need to JOIN
    // services at all — every discoverable workspace passes.
    const needsServiceFilter = qPattern || priceMin != null || priceMax != null;

    // The text q can match the business itself (biz name / tagline) OR
    // a service name. Two-armed EXISTS keeps the query single-pass.
    // Distance filter uses Postgres' built-in trig:
    //   haversine_km(a, b) =
    //     2 * 6371 * asin(sqrt(
    //       sin(radians(b.lat - a.lat)/2)^2 +
    //       cos(radians(a.lat))*cos(radians(b.lat)) *
    //       sin(radians(b.lng - a.lng)/2)^2 ))
    //
    // We compute it once in the SELECT (so we can ORDER BY it + return it)
    // and again in the WHERE (no SQL DSL for "WHERE last_select_alias").
    const distExpr = (lat != null && lng != null) ? `
      2 * 6371 * asin(least(1, sqrt(
        power(sin(radians(($1::float - cs.lat) / 2)), 2) +
        cos(radians(cs.lat)) * cos(radians($1::float)) *
        power(sin(radians(($2::float - cs.lng) / 2)), 2)
      )))
    ` : 'NULL';

    const params = [];
    const push = (v) => { params.push(v); return `$${params.length}`; };

    let dist1 = 'NULL', dist2 = 'NULL';
    if (lat != null && lng != null) {
      const pLat = push(lat);
      const pLng = push(lng);
      dist1 = pLat;
      dist2 = pLng;
    }
    const distSelect = (dist1 !== 'NULL') ? distExpr
      .replace(/\$1::float/g, `${dist1}::float`)
      .replace(/\$2::float/g, `${dist2}::float`)
      : 'NULL';

    const whereParts = ['cs.discoverable = TRUE', 'cs.slug IS NOT NULL'];

    if (category) {
      whereParts.push(`cs.category = ${push(category)}`);
    }

    if (needsServiceFilter) {
      // Build the inner predicate piecewise so absent filters drop out.
      // Only public services may satisfy a Discover match — otherwise a
      // private/only_me service leaks its existence + price band into
      // search and renders a confusing empty card (matching_services
      // already filters visibility='public').
      const inner = ["s.workspace_id = cs.workspace_id", "s.visibility = 'public'"];
      if (qPattern) {
        const p = push(qPattern);
        inner.push(`s.name ILIKE ${p}`);
      }
      if (priceMin != null) inner.push(`s.price >= ${push(priceMin)}`);
      if (priceMax != null) inner.push(`s.price <= ${push(priceMax)}`);

      // When there's a text q, also let business-level text fields
      // (biz_name / tagline) satisfy it without a service hit. So a
      // shop named "Botox Boutique" matches even if their services
      // aren't keyworded.
      if (qPattern) {
        const pTxt = push(qPattern);
        whereParts.push(
          `(EXISTS (SELECT 1 FROM services s WHERE ${inner.join(' AND ')})
            OR cs.biz_name ILIKE ${pTxt}
            OR cs.tagline ILIKE ${pTxt})`,
        );
      } else {
        whereParts.push(`EXISTS (SELECT 1 FROM services s WHERE ${inner.join(' AND ')})`);
      }
    }

    if (radiusKm != null && lat != null && lng != null) {
      whereParts.push(`cs.lat IS NOT NULL AND cs.lng IS NOT NULL`);
      whereParts.push(`(${distSelect}) <= ${push(radiusKm)}`);
    }

    if (minRating != null) {
      // Rating average computed via subquery; min rating gates a business
      // out only if its visible-review average is BELOW the threshold.
      // Businesses with no reviews yet are excluded from a min-rating
      // search (no signal to show), but appear when the filter's off.
      whereParts.push(`(
        SELECT COALESCE(AVG(rating), 0)
        FROM reviews r
        WHERE r.workspace_id = cs.workspace_id AND r.status = 'visible'
      ) >= ${push(minRating)}`);
      whereParts.push(`EXISTS (
        SELECT 1 FROM reviews r2
        WHERE r2.workspace_id = cs.workspace_id AND r2.status = 'visible'
      )`);
    }

    const queryText = `
      SELECT
        cs.workspace_id,
        cs.biz_name,
        cs.slug,
        cs.tagline,
        cs.category,
        cs.address_label,
        cs.lat,
        cs.lng,
        cs.brand_logo_url,
        cs.brand_accent_color,
        ${distSelect} AS distance_km,
        -- Static derived fields read from discover_snapshots (refreshed
        -- every 15min by api/cron/discover-refresh). Falls back to 0 /
        -- NULL when a workspace has no snapshot yet (brand-new
        -- workspaces that the cron hasn't seen).
        COALESCE(ds.service_count, 0)  AS service_count,
        ds.min_price                    AS min_price,
        ds.max_price                    AS max_price,
        ds.cover_photo_url              AS cover_photo_url,
        ds.site_handle                  AS site_handle,
        COALESCE(ds.review_count, 0)   AS review_count,
        ds.rating_avg                   AS rating_avg,
        -- matching_services stays as an inline subquery because the
        -- filter depends on the request (qPattern/priceMin/priceMax)
        -- and can't be precomputed.
        (
          SELECT json_agg(json_build_object(
            'id', s2.id, 'name', s2.name, 'price', s2.price,
            'durationMinutes', s2.duration_minutes
          ) ORDER BY s2.price ASC NULLS LAST)
          FROM services s2 WHERE s2.workspace_id = cs.workspace_id AND s2.visibility = 'public'
            ${qPattern ? `AND s2.name ILIKE ${push(qPattern)}` : ''}
            ${priceMin != null ? `AND s2.price >= ${push(priceMin)}` : ''}
            ${priceMax != null ? `AND s2.price <= ${push(priceMax)}` : ''}
        ) AS matching_services
      FROM calendar_settings cs
      LEFT JOIN discover_snapshots ds ON ds.workspace_id = cs.workspace_id
      WHERE ${whereParts.join(' AND ')}
      ORDER BY ${dist1 !== 'NULL' ? 'distance_km ASC NULLS LAST,' : ''} cs.biz_name ASC
      LIMIT 200
    `;

    const { rows } = await sql.query(queryText, params);
    const businesses = rows.map((r) => ({
      slug:           r.slug,
      bizName:        r.biz_name,
      tagline:        r.tagline || '',
      category:       r.category || null,
      addressLabel:   r.address_label || '',
      lat:            r.lat == null ? null : Number(r.lat),
      lng:            r.lng == null ? null : Number(r.lng),
      distanceKm:     r.distance_km == null ? null : Number(r.distance_km),
      serviceCount:   r.service_count || 0,
      minPrice:       r.min_price != null ? Number(r.min_price) : null,
      maxPrice:       r.max_price != null ? Number(r.max_price) : null,
      // Limit returned matching services so a noisy query doesn't blow
      // the response. UI shows top 3.
      matchingServices: (r.matching_services || []).slice(0, 3).map((s) => ({
        id: s.id, name: s.name, price: Number(s.price || 0), durationMinutes: s.durationMinutes,
      })),
      ratingAvg:    r.rating_avg != null ? Number(r.rating_avg) : null,
      reviewCount:  r.review_count || 0,
      logoUrl:      r.brand_logo_url || null,
      accentColor:  r.brand_accent_color || null,
      coverPhotoUrl: r.cover_photo_url || null,
      siteHandle:   r.site_handle || null,
    }));
    return ok(res, { businesses });
  } catch (err) {
    return serverError(res, err);
  }
}
