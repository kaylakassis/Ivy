// Appointment reminder choices + wording, shared by Calendar > Reminders,
// the service editor and the client drawer. Mirrors
// api/_lib/reminderSettings.js (keep the option list in sync).
import { useEffect, useState } from 'react';
import { api } from './api.js';

export const REMINDER_OPTIONS = [10080, 4320, 2880, 1440, 720, 480, 240, 120, 60, 30];
export const MAX_REMINDERS = 6;
export const CLIENT_DEFAULT_MINUTES = [1440, 480, 60];
export const OWNER_DEFAULT_MINUTES = [1440, 60];

export const REMINDER_PRESETS = [
  { id: 'standard', minutes: [1440, 480, 60] },
  { id: 'light',    minutes: [1440, 120] },
  { id: 'full',     minutes: [10080, 2880, 1440, 120] },
];

// Ready-made sets for the owner's own reminders (the first is their default).
export const OWNER_PRESETS = [
  { id: 'owner-standard', minutes: [1440, 60] },
  { id: 'owner-full',     minutes: [1440, 480, 60] },
  { id: 'owner-hour',     minutes: [60] },
];

export function sortDesc(list) {
  return [...new Set((list || []).map(Number))].sort((a, b) => b - a);
}

export function sameSet(a, b) {
  const x = sortDesc(a);
  const y = sortDesc(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

export function beatLabel(min) {
  const m = Number(min);
  if (m >= 10080 && m % 10080 === 0) return `${m / 10080} week${m === 10080 ? '' : 's'}`;
  if (m >= 1440 && m % 1440 === 0) return `${m / 1440} day${m === 1440 ? '' : 's'}`;
  if (m >= 60 && m % 60 === 0) return `${m / 60} hour${m === 60 ? '' : 's'}`;
  return `${m} minute${m === 1 ? '' : 's'}`;
}

// "1 day, 8 hours and 1 hour before"
export function describeSchedule(minutes) {
  const parts = sortDesc(minutes).map(beatLabel);
  if (parts.length === 0) return '';
  if (parts.length === 1) return `${parts[0]} before`;
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]} before`;
}

// Calendar > Reminders settings, loaded once per page view and shared by
// every component that needs the business default.
let cache = null;
let inflight = null;
const listeners = new Set();

export function setReminderSettingsCache(next) {
  cache = next;
  listeners.forEach((fn) => fn(next));
}

export function useReminderSettings() {
  const [data, setData] = useState(cache);
  const [err, setErr] = useState(null);
  useEffect(() => {
    listeners.add(setData);
    if (!cache) {
      inflight = inflight || api.get('/calendar/reminders');
      inflight.then((r) => setReminderSettingsCache(r))
        .catch((e) => setErr(e.message || 'Could not load reminders'))
        .finally(() => { inflight = null; });
    }
    return () => { listeners.delete(setData); };
  }, []);
  return { data, err };
}
