// Turns the calendar payload into the shape the iPhone app saves for use
// without signal (src/lib/snapshot.js): today's and tomorrow's occurrences
// (recurring series expanded), with the service name on each row.
import { expandBookings } from './utils.js';
import { localISODate } from '../../lib/dateOnly.js';

export function bookingsForSnapshot(calendar, now = new Date()) {
  if (!calendar || !Array.isArray(calendar.bookings)) return { items: [], today: null, tomorrow: null };
  const today = localISODate(now);
  const tomorrow = localISODate(new Date(now.getTime() + 86400e3));
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(start.getTime() + 86400e3);
  const services = new Map((calendar.services || []).map((s) => [s.id, s]));
  const items = expandBookings(calendar.bookings.filter((b) => b && !b.cancelledAt), start, end).map((b) => ({
    id: b.recurrenceMasterId || b.id,
    date: b.occurrenceDate || b.date,
    startMin: b.startMin,
    endMin: b.endMin,
    clientId: b.clientId,
    clientName: b.clientName,
    serviceId: b.serviceId,
    serviceName: services.get(b.serviceId)?.name || null,
    locationAddress: b.locationAddress || null,
    notes: b.notes || null,
    privateNotes: b.privateNotes || null,
    videoUrl: b.videoRoomUrl || null,
    completed: !!(b.completionLog || {})[b.occurrenceDate || b.date],
    noShow: !!b.noShowAt,
  }));
  return { items, today, tomorrow };
}
