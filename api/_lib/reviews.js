// Shared serializer + helpers for reviews.

export function serializeReview(row, { includeHidden = false, includeBookingId = false } = {}) {
  if (!row) return null;
  return {
    id:           row.id,
    rating:       Number(row.rating),
    text:         row.text || '',
    reviewerName: row.reviewer_name || 'Anonymous',
    status:       row.status,
    ownerResponse:    row.owner_response || null,
    ownerRespondedAt: row.owner_responded_at,
    createdAt:    row.created_at,
    ...(includeBookingId ? { bookingId: row.booking_id } : {}),
    ...(includeHidden    ? {} : (row.status === 'hidden' ? { hidden: true } : {})),
  };
}
