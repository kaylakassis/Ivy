// Cron: every 10 min, fire any sites whose scheduled_publish_at has
// elapsed. Each one's `scheduled_pages` is copied into `pages`, the
// schedule is cleared, and a version snapshot is added so the change
// is roll-back-able.
//
// Auth: matches the other crons. Vercel cron sends
//   Authorization: Bearer ${CRON_SECRET}
// Admin trigger via header. Signed-in super-admin via session cookie.
// Without any of those, refuse - without this check anyone on the
// internet can force-publish every scheduled website in the system.

import { sql } from '../_lib/db.js';
import { ensureSchemaApplied } from '../_lib/ensureSchema.js';
import { isSuperAdminBySession } from '../_lib/admin.js';
import { ok, serverError, unauthorized } from '../_lib/json.js';
import { trackCron } from '../_lib/cronMetrics.js';

async function handler(req, res) {
  // Vercel cron jobs hit us as GET requests with a magic header. We
  // accept either GET (cron) or POST (manual admin trigger).
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    res.statusCode = 405;
    return res.end('Method Not Allowed');
  }

  const cronAuth = !!process.env.CRON_SECRET
    && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
  const adminAuth = process.env.ADMIN_SECRET
    && req.headers['x-admin-secret'] === process.env.ADMIN_SECRET;
  const userAuth = !cronAuth && !adminAuth ? await isSuperAdminBySession(req) : false;
  if (!cronAuth && !adminAuth && !userAuth) return unauthorized(res);

  try {
    await ensureSchemaApplied();
    const due = await sql`
      SELECT id, scheduled_pages
      FROM websites
      WHERE scheduled_publish_at IS NOT NULL
        AND scheduled_publish_at <= NOW()
    `;
    let fired  = 0;
    let failed = 0;
    for (const row of due.rows) {
      try {
        // Snapshot current state into versions for rollback.
        const cur = await sql`SELECT * FROM websites WHERE id = ${row.id}`;
        const cs = cur.rows[0];
        await sql`
          INSERT INTO website_versions (website_id, snapshot)
          VALUES (${row.id}, ${JSON.stringify({
            template: cs.template, sections: cs.sections, pages: cs.pages,
            custom_css: cs.custom_css, font_pair: cs.font_pair,
            seo_title: cs.seo_title, seo_description: cs.seo_description,
            seo_og_image: cs.seo_og_image, favicon_url: cs.favicon_url,
            redirects: cs.redirects, exit_intent_popup: cs.exit_intent_popup,
            sticky_cta: cs.sticky_cta,
          })}::jsonb)
        `;
        // Promote scheduled_pages into BOTH the draft (pages/sections) and
        // the published snapshot (published_pages/published_sections) - the
        // public site reads the published_* columns (publicSite.js), so
        // without setting those the scheduled content would never go live.
        const schedPages = Array.isArray(row.scheduled_pages) ? row.scheduled_pages : [];
        const homeSections = (schedPages.find((p) => p.slug === '') || schedPages[0])?.sections || [];
        await sql`
          UPDATE websites SET
            pages                = ${JSON.stringify(schedPages)}::jsonb,
            sections             = ${JSON.stringify(homeSections)}::jsonb,
            published_pages      = ${JSON.stringify(schedPages)}::jsonb,
            published_sections   = ${JSON.stringify(homeSections)}::jsonb,
            scheduled_pages      = NULL,
            scheduled_publish_at = NULL,
            launched             = TRUE,
            published_at         = NOW(),
            updated_at           = NOW()
          WHERE id = ${row.id}
        `;
        fired += 1;
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[cron/scheduled-publish] site', row.id, 'failed:', e.message);
        failed += 1;
      }
    }
    return ok(res, { fired, failed, total: due.rows.length });
  } catch (err) {
    return serverError(res, err);
  }
}

export default trackCron('scheduled-publish', handler);
