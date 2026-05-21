// API-backed calendar store: settings + services + blocks + bookings.
// GET on mount; mutations call dedicated endpoints and refresh local state.
import { useEffect, useState, useCallback } from 'react';
import { api } from '../../lib/api.js';

export const EMPTY_CAL = {
  settings: {
    bizName: 'My business',
    slug: '',
    slotMinutes: 30,
    bufferMinutes: 0,
    discoverable: false,
    tagline: '',
    category: null,
    addressLabel: '',
    lat: null,
    lng: null,
    availability: { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] },
  },
  services: [],
  blocks: [],
  bookings: [],
};

// useCalendar(window?) — `window` is { from, to } in YYYY-MM-DD.
// Without it the hook loads everything (legacy behavior — matches
// existing callers that don't yet pass a window). With it the hook
// loads only bookings + blocks inside the window, which is the
// scaling-safe default at workspace sizes that have thousands of
// past bookings.
//
// Loaded set is replaced on window change — we don't accumulate
// across windows because the calendar UI only renders the
// currently-visible window. A user navigating month-to-month will
// see one fetch per month change; a workspace with 1000+ bookings
// per month sees ~1000 rows per fetch instead of 10K+.
export function useCalendar(window) {
  const [cal, setCal] = useState(EMPTY_CAL);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const queryString = window?.from && window?.to
    ? `?from=${encodeURIComponent(window.from)}&to=${encodeURIComponent(window.to)}`
    : '';

  const refresh = useCallback(async () => {
    const r = await api.get('/calendar' + queryString);
    setCal(r.calendar);
    return r.calendar;
  }, [queryString]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    api.get('/calendar' + queryString)
      .then((r) => live && setCal(r.calendar))
      .catch((e) => live && setError(e))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [queryString]);

  const patchSettings = useCallback(async (patch) => {
    const r = await api.patch('/calendar', patch);
    setCal((c) => ({ ...c, settings: { ...c.settings, ...r.settings } }));
    return r.settings;
  }, []);

  const saveServices = useCallback(async (services) => {
    const r = await api.put('/calendar/services', { services });
    setCal((c) => ({ ...c, services: r.services }));
    return r.services;
  }, []);

  const saveAvailability = useCallback(async (availability) => {
    const r = await api.patch('/calendar', { availability });
    setCal((c) => ({ ...c, settings: { ...c.settings, ...r.settings } }));
    return r.settings;
  }, []);

  // addBlock accepts the optional event fields (blocksBookings,
  // color, notes, allDay) — defaults preserve legacy callers that
  // just pass date/start/end/label.
  const addBlock = useCallback(async ({
    date, startMin, endMin, label,
    blocksBookings, color, notes, allDay,
  }) => {
    const r = await api.post('/calendar/blocks', {
      date, startMin, endMin, label,
      blocksBookings, color, notes, allDay,
    });
    setCal((c) => ({ ...c, blocks: [...c.blocks, r.block] }));
    return r.block;
  }, []);

  const updateBlock = useCallback(async (id, patch) => {
    const r = await api.patch('/calendar/blocks/' + id, patch);
    setCal((c) => ({ ...c, blocks: c.blocks.map((b) => b.id === id ? r.block : b) }));
    return r.block;
  }, []);

  const removeBlock = useCallback(async (id) => {
    await api.del('/calendar/blocks/' + id);
    setCal((c) => ({ ...c, blocks: c.blocks.filter((b) => b.id !== id) }));
  }, []);

  const cancelBooking = useCallback(async (id) => {
    await api.del('/calendar/bookings/' + id);
    setCal((c) => ({ ...c, bookings: c.bookings.filter((b) => b.id !== id) }));
  }, []);

  const cancelOccurrence = useCallback(async (id, dateISO) => {
    const r = await api.patch('/calendar/bookings/' + id, { cancelOccurrence: dateISO });
    setCal((c) => ({
      ...c,
      bookings: c.bookings.map((b) => b.id === id ? r.booking : b),
    }));
    return r.booking;
  }, []);

  const updateBooking = useCallback(async (id, patch) => {
    const r = await api.patch('/calendar/bookings/' + id, patch);
    setCal((c) => ({
      ...c,
      bookings: c.bookings.map((b) => b.id === id ? r.booking : b),
    }));
    return r.booking;
  }, []);

  const createBooking = useCallback(async (input) => {
    const r = await api.post('/calendar/bookings', input);
    setCal((c) => ({ ...c, bookings: [...c.bookings, r.booking] }));
    return r.booking;
  }, []);

  // Merge an already-mutated booking (e.g. from no-show/tip/fee endpoints
  // that the drawer calls directly) into state so the grid + open drawer
  // reflect it without a full refetch.
  const applyBooking = useCallback((booking) => {
    if (!booking?.id) return;
    setCal((c) => ({ ...c, bookings: c.bookings.map((b) => b.id === booking.id ? booking : b) }));
  }, []);

  const completeBooking = useCallback(async (id, occurrenceDate, body) => {
    const r = await api.post('/calendar/bookings/complete', { id, occurrenceDate, ...body });
    setCal((c) => ({ ...c, bookings: c.bookings.map((b) => b.id === id ? r.booking : b) }));
    return r.booking;
  }, []);

  const editCompletion = useCallback(async (id, occurrenceDate, body) => {
    const r = await api.patch('/calendar/bookings/complete', { id, occurrenceDate, ...body });
    setCal((c) => ({ ...c, bookings: c.bookings.map((b) => b.id === id ? r.booking : b) }));
    return r.booking;
  }, []);

  const clearCompletion = useCallback(async (id, occurrenceDate) => {
    const r = await api.del('/calendar/bookings/complete', { id, occurrenceDate });
    setCal((c) => ({ ...c, bookings: c.bookings.map((b) => b.id === id ? r.booking : b) }));
    return r.booking;
  }, []);

  return {
    cal, loading, error, refresh,
    patchSettings, saveServices, saveAvailability,
    addBlock, updateBlock, removeBlock,
    createBooking, updateBooking, applyBooking, cancelBooking, cancelOccurrence,
    completeBooking, editCompletion, clearCompletion,
  };
}
