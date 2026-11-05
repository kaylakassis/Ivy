// Appointment reminder settings: who gets reminded, when, and how.
//
// Two independent audiences:
//
//   Clients  (calendar_settings.client_reminders JSONB, NULL = defaults)
//     { enabled: bool, minutes: int[], channels: { email, sms, push } }
//     The schedule a client gets is the most specific one that applies:
//       1. the client's own profile (clients.reminder_settings):
//            { mode: 'off' }  or  { mode: 'custom', minutes: [...] }
//       2. the booked service's own schedule (services.reminder_minutes),
//          unless the service follows the business default
//       3. the business default (client_reminders.minutes)
//     Two switches sit above that and always win: the business turning
//     client reminders off (enabled=false), and the client turning
//     reminders off for themselves in their portal
//     (clients.notification_prefs.reminders = false). Email opt-outs,
//     SMS consent / STOP and push mutes are still honoured per channel
//     by the senders.
//
//   The team (calendar_settings.owner_reminders JSONB, NULL = defaults)
//     { enabled: bool, minutes: int[], channels: { email, push } }
//     The owner's own heads-up about their upcoming appointments. A
//     booking assigned to a helper with a login reminds that helper (push)
//     instead of the owner. Never affects what clients get.
//
// The cron (api/cron/booking-reminders.js) resolves the client schedule in
// SQL with clientBeatsSql()/ownerBeatsSql() below; resolveClientSchedule()
// is the same rule in JS for the API and the tests (a test keeps the two
// in step).

// Every choice offered in the app, largest first.
export const REMINDER_OPTIONS = [10080, 4320, 2880, 1440, 720, 480, 240, 120, 60, 30];
const OPTION_SET = new Set(REMINDER_OPTIONS);
export const MAX_REMINDERS = 6;

// The schedule every service used to start with (1 week, 2 days, 1 day,
// 2 hours). A service still holding exactly this set was never customised,
// so it follows the business default.
export const LEGACY_SERVICE_DEFAULT = [10080, 2880, 1440, 120];

export const CLIENT_DEFAULT_MINUTES = [1440, 480, 60];
export const OWNER_DEFAULT_MINUTES = [1440, 60];

export const REMINDER_PRESETS = [
  { id: 'standard', minutes: [1440, 480, 60] },
  { id: 'light',    minutes: [1440, 120] },
  { id: 'full',     minutes: [10080, 2880, 1440, 120] },
];

export function sortDesc(list) {
  return [...new Set(list)].sort((a, b) => b - a);
}

export function sameSet(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  const x = sortDesc(a.map(Number));
  const y = sortDesc(b.map(Number));
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

// "1 day", "8 hours", "30 minutes", "1 week", "3 days".
export function beatLabel(min) {
  const m = Number(min);
  if (m >= 10080 && m % 10080 === 0) return `${m / 10080} week${m === 10080 ? '' : 's'}`;
  if (m >= 1440 && m % 1440 === 0) return `${m / 1440} day${m === 1440 ? '' : 's'}`;
  if (m >= 60 && m % 60 === 0) return `${m / 60} hour${m === 60 ? '' : 's'}`;
  return `${m} minute${m === 1 ? '' : 's'}`;
}

// "1 day, 8 hours and 1 hour before". Empty → ''.
export function describeSchedule(minutes) {
  const parts = sortDesc((minutes || []).map(Number)).map(beatLabel);
  if (parts.length === 0) return '';
  if (parts.length === 1) return `${parts[0]} before`;
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]} before`;
}

// Validate a business- or client-level schedule: only the offered
// choices, no duplicates, at most MAX_REMINDERS. Returns { value } or
// { error }.
export function cleanSchedule(raw, { allowEmpty = false } = {}) {
  if (!Array.isArray(raw)) return { error: 'minutes must be a list' };
  if (raw.length > 20) return { error: 'Too many reminders' };
  const out = [];
  for (const v of raw) {
    const n = Number(v);
    if (!Number.isInteger(n) || !OPTION_SET.has(n)) return { error: 'That reminder time is not one of the choices' };
    out.push(n);
  }
  const value = sortDesc(out);
  if (value.length > MAX_REMINDERS) return { error: `Pick up to ${MAX_REMINDERS} reminders` };
  if (!allowEmpty && value.length === 0) return { error: 'Pick at least one reminder time' };
  return { value };
}

function intList(raw) {
  if (!Array.isArray(raw)) return null;
  const out = raw.map(Number).filter((n) => Number.isInteger(n) && n > 0 && n <= 1000000);
  return sortDesc(out);
}

// Business-wide client reminder settings from a calendar_settings row (or
// its client_reminders value). Missing → the standard 1 day / 8 hours /
// 1 hour, every channel on.
export function clientRemindersFrom(csRowOrValue) {
  const v = csRowOrValue && 'client_reminders' in Object(csRowOrValue)
    ? csRowOrValue.client_reminders : csRowOrValue;
  const o = v && typeof v === 'object' ? v : {};
  const ch = o.channels && typeof o.channels === 'object' ? o.channels : {};
  return {
    enabled: o.enabled !== false,
    minutes: intList(o.minutes) || CLIENT_DEFAULT_MINUTES.slice(),
    channels: { email: ch.email !== false, sms: ch.sms !== false, push: ch.push !== false },
    customized: !!(v && typeof v === 'object' && Object.keys(v).length),
  };
}

export function ownerRemindersFrom(csRowOrValue) {
  const v = csRowOrValue && 'owner_reminders' in Object(csRowOrValue)
    ? csRowOrValue.owner_reminders : csRowOrValue;
  const o = v && typeof v === 'object' ? v : {};
  const ch = o.channels && typeof o.channels === 'object' ? o.channels : {};
  return {
    enabled: o.enabled !== false,
    minutes: intList(o.minutes) || OWNER_DEFAULT_MINUTES.slice(),
    channels: { email: ch.email !== false, push: ch.push !== false },
    customized: !!(v && typeof v === 'object' && Object.keys(v).length),
  };
}

// Validate a PATCH body for one audience. `kind` is 'clients' | 'owner'.
// Partial bodies merge onto `current`. Returns { value } (the JSON to
// store) or { error }.
export function mergeAudienceSettings(kind, current, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: `${kind} must be an object` };
  const next = {
    enabled: current.enabled,
    minutes: current.minutes.slice(),
    channels: { ...current.channels },
  };
  if ('enabled' in body) next.enabled = !!body.enabled;
  if ('minutes' in body) {
    const r = cleanSchedule(body.minutes);
    if (r.error) return r;
    next.minutes = r.value;
  }
  if ('channels' in body) {
    const c = body.channels;
    if (!c || typeof c !== 'object' || Array.isArray(c)) return { error: 'channels must be an object' };
    const allowed = kind === 'clients' ? ['email', 'sms', 'push'] : ['email', 'push'];
    for (const k of allowed) if (k in c) next.channels[k] = !!c[k];
  }
  return { value: next };
}

// Does this services row follow the business default? An explicit flag
// wins; rows saved before the flag existed follow the default when they
// still hold the old built-in schedule.
export function serviceFollowsDefault(row) {
  if (!row) return true;
  if (row.reminders_use_default === true) return true;
  if (row.reminders_use_default === false) return false;
  const mins = Array.isArray(row.reminder_minutes) ? row.reminder_minutes : null;
  if (mins === null) return true;
  return sameSet(mins, LEGACY_SERVICE_DEFAULT);
}

// Validate a per-client override. null / { mode: 'default' } clears it.
export function cleanClientOverride(raw) {
  if (raw == null) return { value: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { error: 'reminderSettings must be an object' };
  const mode = String(raw.mode || '');
  if (mode === 'default') return { value: null };
  if (mode === 'off') return { value: { mode: 'off' } };
  if (mode === 'custom') {
    const r = cleanSchedule(raw.minutes);
    if (r.error) return r;
    return { value: { mode: 'custom', minutes: r.value } };
  }
  return { error: 'mode must be default, off or custom' };
}

export function clientOverrideFrom(raw) {
  if (!raw || typeof raw !== 'object') return { mode: 'default' };
  if (raw.mode === 'off') return { mode: 'off' };
  if (raw.mode === 'custom') return { mode: 'custom', minutes: intList(raw.minutes) || [] };
  return { mode: 'default' };
}

// The client schedule for one booking. `business` = clientRemindersFrom(),
// `service` = services row or null, `client` = clients row or null.
// Returns { minutes, source } where source is one of
// 'business-off' | 'client-opted-out' | 'client-off' | 'client' |
// 'service' | 'business'.
export function resolveClientSchedule({ business, service = null, client = null }) {
  const biz = business || clientRemindersFrom(null);
  if (!biz.enabled) return { minutes: [], source: 'business-off' };
  if (client && (client.notification_prefs || {}).reminders === false) {
    return { minutes: [], source: 'client-opted-out' };
  }
  const ov = clientOverrideFrom(client?.reminder_settings);
  if (ov.mode === 'off') return { minutes: [], source: 'client-off' };
  if (ov.mode === 'custom') return { minutes: ov.minutes, source: 'client' };
  if (service && !serviceFollowsDefault(service)) {
    return { minutes: sortDesc(service.reminder_minutes || []), source: 'service' };
  }
  return { minutes: biz.minutes.slice(), source: 'business' };
}

// SQL twins of the rules above, for the cron's candidate query. Aliases:
// cs = calendar_settings, s = services, c = clients.
const jsonInts = (expr) => `ARRAY(
  SELECT x::int FROM jsonb_array_elements_text(
    CASE WHEN jsonb_typeof(${expr}) = 'array' THEN ${expr} ELSE '[]'::jsonb END) x
  WHERE x ~ '^[0-9]{1,6}$')`;
const LEGACY_SQL = `ARRAY[${LEGACY_SERVICE_DEFAULT.join(',')}]::int[]`;

export function clientBeatsSql() {
  return `CASE
    WHEN cs.client_reminders->'enabled' = 'false'::jsonb THEN ARRAY[]::int[]
    WHEN c.notification_prefs->'reminders' = 'false'::jsonb THEN ARRAY[]::int[]
    WHEN c.reminder_settings->>'mode' = 'off' THEN ARRAY[]::int[]
    WHEN c.reminder_settings->>'mode' = 'custom' THEN ${jsonInts("c.reminder_settings->'minutes'")}
    WHEN s.id IS NOT NULL AND (
           s.reminders_use_default = FALSE
        OR (s.reminders_use_default IS NULL
            AND NOT (COALESCE(s.reminder_minutes, ${LEGACY_SQL}) @> ${LEGACY_SQL}
                 AND COALESCE(s.reminder_minutes, ${LEGACY_SQL}) <@ ${LEGACY_SQL})))
      THEN COALESCE(s.reminder_minutes, ARRAY[]::int[])
    WHEN jsonb_typeof(cs.client_reminders->'minutes') = 'array' THEN ${jsonInts("cs.client_reminders->'minutes'")}
    ELSE ARRAY[${CLIENT_DEFAULT_MINUTES.join(',')}]::int[]
  END`;
}

export function ownerBeatsSql() {
  return `CASE
    WHEN cs.owner_reminders->'enabled' = 'false'::jsonb THEN ARRAY[]::int[]
    WHEN jsonb_typeof(cs.owner_reminders->'minutes') = 'array' THEN ${jsonInts("cs.owner_reminders->'minutes'")}
    ELSE ARRAY[${OWNER_DEFAULT_MINUTES.join(',')}]::int[]
  END`;
}

// Public shape for the settings API / UI.
export function serializeReminderSettings(csRow) {
  const clients = clientRemindersFrom(csRow?.client_reminders ?? null);
  const owner = ownerRemindersFrom(csRow?.owner_reminders ?? null);
  return {
    clients: { enabled: clients.enabled, minutes: clients.minutes, channels: clients.channels },
    owner: { enabled: owner.enabled, minutes: owner.minutes, channels: owner.channels },
  };
}
