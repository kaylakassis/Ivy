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

export function useCalendar() {
  const [cal, setCal] = useState(EMPTY_CAL);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    const r = await api.get('/calendar');
    setCal(r.calendar);
    return r.calendar;
  }, []);

  useEffect(() => {
    let live = true;
    api.get('/calendar')
      .then((r) => live && setCal(r.calendar))
      .catch((e) => live && setError(e))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, []);

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

  const addBlock = useCallback(async ({ date, startMin, endMin, label }) => {
    const r = await api.post('/calendar/blocks', { date, startMin, endMin, label });
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

  return {
    cal, loading, error, refresh,
    patchSettings, saveServices, saveAvailability,
    addBlock, updateBlock, removeBlock,
    createBooking, updateBooking, cancelBooking, cancelOccurrence,
  };
}
