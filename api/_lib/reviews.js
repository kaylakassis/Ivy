// Shared serializer + helpers for reviews.

// How a reviewer is named on anything the public can read: first name and
// the initial of the last name ("Jane D."). A business's public page
// should not be a list of its clients' full names. The owner's own screens
// keep the name as given.
const NAME_PLACEHOLDERS = new Set(['anonymous', 'a client', 'verified client']);
export function publicReviewerName(name) {
  const n = String(name || '').trim().replace(/\s+/g, ' ');
  if (!n) return 'Anonymous';
  if (NAME_PLACEHOLDERS.has(n.toLowerCase())) return n;
  const parts = n.split(' ');
  // A name taken from an email address ("jane.doe") is one word: keep
  // only what comes before the first dot or underscore.
  const first = (parts.length === 1 ? parts[0].split(/[._@]/)[0] : parts[0]).slice(0, 40) || 'Anonymous';
  if (parts.length === 1) return first;
  const last = parts[parts.length - 1].replace(/[^\p{L}]/gu, '');
  return last ? `${first} ${last[0].toUpperCase()}.` : first;
}

export function serializeReview(row, { includeHidden = false, includeBookingId = false } = {}) {
  if (!row) return null;
  return {
    id:           row.id,
    rating:       Number(row.rating),
    text:         row.text || '',
    reviewerName: includeHidden ? (row.reviewer_name || 'Anonymous') : publicReviewerName(row.reviewer_name),
    status:       row.status,
    ownerResponse:    row.owner_response || null,
    ownerRespondedAt: row.owner_responded_at,
    // An appeal is a private note from the owner to Ivy about this review.
    // Only the owner's own screens (includeHidden) ever get it; the public
    // page and the reviewer do not.
    ...(includeHidden ? {
      appealStatus:     row.appeal_status || 'none',
      appealReason:     row.appeal_reason || null,
      appealRequestedAt: row.appeal_requested_at || null,
    } : {}),
    createdAt:    row.created_at,
    ...(includeBookingId ? { bookingId: row.booking_id } : {}),
    ...(includeHidden    ? {} : (row.status === 'hidden' ? { hidden: true } : {})),
  };
}
