// Website version snapshots, shared by Publish (api/website/publish.js),
// roll-back (api/website/versions.js) and Ivy's website tools
// (api/_lib/ivyWebsiteTools.js), so all three save and restore exactly the
// same fields.
import { sql } from './db.js';

export const MAX_WEBSITE_VERSIONS = 50;

export function websiteSnapshot(row) {
  return {
    template: row.template, sections: row.sections, pages: row.pages,
    custom_css: row.custom_css, font_pair: row.font_pair,
    seo_title: row.seo_title, seo_description: row.seo_description,
    seo_og_image: row.seo_og_image, favicon_url: row.favicon_url,
    redirects: row.redirects, exit_intent_popup: row.exit_intent_popup,
    sticky_cta: row.sticky_cta,
  };
}

// Store the row's current state as a version, keeping the newest 50.
export async function saveWebsiteVersion(row, userId = null) {
  await sql`
    INSERT INTO website_versions (website_id, snapshot, created_by)
    VALUES (${row.id}, ${JSON.stringify(websiteSnapshot(row))}::jsonb, ${userId || null})
  `;
  await sql`
    DELETE FROM website_versions
    WHERE website_id = ${row.id}
      AND id NOT IN (
        SELECT id FROM website_versions WHERE website_id = ${row.id}
        ORDER BY created_at DESC LIMIT ${MAX_WEBSITE_VERSIONS}
      )
  `;
}

// Roll back to a snapshot: the current state is saved as a version first
// (so the roll-back can itself be undone), then the snapshot is written back.
// Pages and sections land in the draft; the other fields are not
// draft-gated and apply to the live site at once.
export async function restoreWebsiteVersion(row, snap, userId = null) {
  await saveWebsiteVersion(row, userId);
  // JSONB gotcha: JSON.stringify(null) is the string 'null' (jsonb null, not
  // SQL NULL); `jp` maps absent/null to SQL NULL so COALESCE keeps the value.
  const jp = (v) => (v === undefined || v === null ? null : JSON.stringify(v));
  const s = snap || {};
  await sql`
    UPDATE websites SET
      template          = COALESCE(${s.template ?? null}, template),
      sections          = COALESCE(${jp(s.sections)}::jsonb, sections),
      pages             = COALESCE(${jp(s.pages)}::jsonb, pages),
      custom_css        = COALESCE(${s.custom_css ?? null}, custom_css),
      font_pair         = COALESCE(${s.font_pair ?? null}, font_pair),
      seo_title         = COALESCE(${s.seo_title ?? null}, seo_title),
      seo_description   = COALESCE(${s.seo_description ?? null}, seo_description),
      seo_og_image      = COALESCE(${s.seo_og_image ?? null}, seo_og_image),
      favicon_url       = COALESCE(${s.favicon_url ?? null}, favicon_url),
      redirects         = COALESCE(${jp(s.redirects)}::jsonb, redirects),
      exit_intent_popup = COALESCE(${jp(s.exit_intent_popup)}::jsonb, exit_intent_popup),
      sticky_cta        = COALESCE(${jp(s.sticky_cta)}::jsonb, sticky_cta),
      updated_at        = NOW()
    WHERE id = ${row.id}
  `;
}
