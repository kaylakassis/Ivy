// POST /site/:handle/pv — public analytics ping.
//
// Fires from the rendered site on initial load. Records:
//   • which page slug the visitor landed on
//   • a truncated referrer
//   • a rough UA bucket (mobile / desktop / bot)
//
// No IP, no UA string, no cookies — keeps us out of GDPR/cookie-banner
// territory entirely. Owners get aggregate counts in the Editor's
// Traffic panel.

import { sql } from '../../_lib/db.js';
import { readBody } from '../../_lib/body.js';
import { ensureSchemaApplied } from '../../_lib/ensureSchema.js';
import { enforce, getClientIp } from '../../_lib/rate-limit.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.statusCode = 405;
    return res.end('Method Not Allowed');
  }
  try {
    await ensureSchemaApplied();
    // 60 events per IP per minute — generous, but bots that try to skew
    // counts get throttled.
    const ip = getClientIp(req);
    if (await enforce(req, res, [{ key: `pv:${ip}`, max: 60, windowSeconds: 60 }])) return;

    const { handle } = req.query;
    const body = await readBody(req).catch(() => ({}));
    const slug = String(body?.slug || '').toLowerCase().slice(0, 80);
    const referrer = body?.referrer ? String(body.referrer).slice(0, 300) : null;

    // Find the site quickly (one indexed lookup). Skip if unpublished.
    const found = await sql`
      SELECT id FROM websites
      WHERE handle = ${String(handle || '').toLowerCase()}
        AND published_at IS NOT NULL
    `;
    if (found.rows.length === 0) {
      // Silently 204 so we don't expose the published/unpublished status.
      res.statusCode = 204;
      return res.end();
    }

    // Coarse UA classification — keeps the table small + analytics
    // free of fingerprint-grade data.
    const ua = String(req.headers['user-agent'] || '');
    let uaClass = 'desktop';
    if (/bot|crawl|spider|preview|facebookexternalhit/i.test(ua)) uaClass = 'bot';
    else if (/mobi|iphone|ipad|android/i.test(ua)) uaClass = 'mobile';

    await sql`
      INSERT INTO website_pageviews (website_id, page_slug, referrer, ua_class)
      VALUES (${found.rows[0].id}, ${slug}, ${referrer}, ${uaClass})
    `;
    res.statusCode = 204;
    return res.end();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[pv] error:', err);
    res.statusCode = 204;
    return res.end();
  }
}
