// The business's custom client fields (GET /api/clients/fields), shared by
// the add form, the client profile, the import preview and the settings
// sheet. One fetch per page load; changes made in the settings sheet call
// setClientFields so every open view updates.
import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';

let cache = null;          // { fields, max, dateOrder }
let inflight = null;
const listeners = new Set();

export function loadClientFields({ force = false } = {}) {
  if (cache && !force) return Promise.resolve(cache);
  if (inflight && !force) return inflight;
  inflight = api.get('/clients/fields')
    .then((r) => {
      cache = { fields: r.fields || [], max: r.max || 25, dateOrder: r.dateOrder === 'dmy' ? 'dmy' : 'mdy' };
      listeners.forEach((fn) => fn(cache));
      return cache;
    })
    .catch(() => cache || { fields: [], max: 25, dateOrder: 'mdy' })
    .finally(() => { inflight = null; });
  return inflight;
}

export function setClientFields(fields) {
  cache = { ...(cache || { max: 25, dateOrder: 'mdy' }), fields };
  listeners.forEach((fn) => fn(cache));
}

export function useClientFields() {
  const [state, setState] = useState(cache);
  useEffect(() => {
    listeners.add(setState);
    if (!cache) loadClientFields().then(setState);
    return () => { listeners.delete(setState); };
  }, []);
  return state || { fields: [], max: 25, dateOrder: 'mdy', loading: true };
}

export const FIELD_TYPE_LABELS = {
  text: 'Text',
  number: 'Number',
  date: 'Date',
  boolean: 'Yes / no',
  select: 'Dropdown',
};
