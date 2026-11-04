// Shape of a websites row as the editor sees it (GET/PUT /api/website,
// POST /api/website/discard-draft). The iPhone app runs older editor code
// against this, so fields are only ever added, never renamed or removed.
export function serializeWebsite(row) {
  if (!row) return null;
  // Unpublished-changes cue: only meaningful once the site is live. True
  // when the draft (sections/pages) differs from the published snapshot.
  // (published_* is copied from the draft on Publish, so they match until
  // the next edit.) Stable key order - both come from the same source.
  const stable = (v) => JSON.stringify(v ?? null);
  const hasUnpublishedChanges = !!row.published_at && (
    stable(row.sections) !== stable(row.published_sections ?? row.sections)
    || stable(row.pages) !== stable(row.published_pages ?? row.pages)
  );
  return {
    id:            row.id,
    hasUnpublishedChanges,
    handle:        row.handle,
    businessName:  row.business_name,
    template:      row.template,
    sections:      row.sections || [],
    pages:         Array.isArray(row.pages) ? row.pages : [],
    customCss:     row.custom_css || '',
    fontPair:      row.font_pair || null,
    customDomain:  row.custom_domain,
    domainStatus:  row.domain_status || null,
    launched:      row.launched,
    visibility:    row.visibility || 'public',
    publishedAt:   row.published_at,
    updatedAt:     row.updated_at,
    seoTitle:        row.seo_title || '',
    seoDescription:  row.seo_description || '',
    seoOgImage:      row.seo_og_image || '',
    faviconUrl:      row.favicon_url || '',
    redirects:         Array.isArray(row.redirects) ? row.redirects : [],
    formDestinations:  Array.isArray(row.form_destinations) ? row.form_destinations : [],
    exitIntentPopup:   row.exit_intent_popup || null,
    stickyCta:         row.sticky_cta || null,
    scheduledPublishAt: row.scheduled_publish_at || null,
    scheduledPages:     Array.isArray(row.scheduled_pages) ? row.scheduled_pages : null,
  };
}
