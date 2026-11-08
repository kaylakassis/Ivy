// Tap-to-call and tap-for-directions links. Plain tel: and maps links, so
// they keep working with no signal (the Phone and Maps apps take over).
export function telHref(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/[^\d+]/g, '');
  return digits.replace(/\D/g, '').length >= 7 ? `tel:${digits}` : null;
}

export function mapsHref(address) {
  const a = String(address || '').trim();
  return a ? `https://maps.apple.com/?q=${encodeURIComponent(a)}` : null;
}

// A saved booking's phone: on the booking itself (dashboard copy) or from
// the saved client list.
export function phoneForBooking(booking, clients) {
  if (booking?.clientPhone) return booking.clientPhone;
  const c = booking?.clientId && Array.isArray(clients) ? clients.find((x) => x.id === booking.clientId) : null;
  return c?.phone || null;
}

// The next saved appointment for a client (today or tomorrow), or null.
export function nextBookingFor(clientId, bookings, todayISO, nowMin) {
  if (!clientId || !Array.isArray(bookings)) return null;
  const mine = bookings.filter((b) => b.clientId === clientId && !b.completed && !b.noShow
    && (b.date > todayISO || (b.date === todayISO && (b.endMin ?? 0) > nowMin)));
  mine.sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.startMin || 0) - (b.startMin || 0));
  return mine[0] || null;
}
