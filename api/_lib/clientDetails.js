// The richer client record: address parts, birthday, gender or pronouns,
// emergency contact, preferred contact method, work, and the business's own
// custom fields. One place validates and serializes them so the owner API
// (POST /api/clients, PATCH /api/clients/:id), the importer
// (api/_lib/clientImport.js) and Ivy's client tools can never disagree.
//
// Privacy: everything here is owner data. serializeClient includes it;
// serializeClientMinimal (helpers without the clients permission) does not,
// public pages never read these columns, and a client sees only their own
// birthday / address / emergency contact through /api/me/profile.
//
// Storage (api/_lib/schema.js): plain columns on clients, plus
// clients.custom_fields JSONB keyed by client_field_definitions.id, so a
// renamed field keeps its values.
import { sql } from './db.js';

export const DETAIL_LIMITS = {
  street: 200, city: 100, region: 100, postalCode: 20, country: 80,
  pronouns: 60, occupation: 120,
  emergencyName: 120, emergencyPhone: 40, emergencyRelationship: 60,
};
export const PREFERRED_CONTACT = ['email', 'text', 'call'];

// Custom fields: caps keep a business's definitions and every client's
// values small.
export const CUSTOM_FIELD_TYPES = ['text', 'number', 'date', 'boolean', 'select'];
export const CUSTOM_FIELD_MAX = 25;       // definitions per business
export const CUSTOM_LABEL_MAX = 60;
export const CUSTOM_OPTIONS_MAX = 30;     // choices per dropdown
export const CUSTOM_OPTION_MAX = 60;      // characters per choice
export const CUSTOM_TEXT_MAX = 1000;      // characters per text value
export const CUSTOM_JSON_MAX = 16000;     // bytes of values per client

const ADDRESS_COLS = {
  street: 'address_street', city: 'address_city', region: 'address_region',
  postalCode: 'address_postal_code', country: 'address_country',
};

// Strip control characters (keep newlines out of one-line fields too).
function clean(v, max) {
  if (v == null) return null;
  const s = String(v).replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}

export class ClientDetailError extends Error {}

function daysIn(month, year) {
  if (month === 2) return year && !(year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? 28 : 29;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

// A birthday as { month, day, year|null }. Accepts 'YYYY-MM-DD', '--MM-DD'
// (no year, ISO 8601), 'MM-DD', or { month, day, year }. Empty → null.
// Anything else throws ClientDetailError.
export function parseBirthday(v) {
  if (v == null || v === '') return null;
  let month; let day; let year = null;
  if (typeof v === 'object') {
    month = Number(v.month); day = Number(v.day);
    year = v.year == null || v.year === '' ? null : Number(v.year);
  } else {
    const s = String(v).trim().slice(0, 40);
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:T.*)?$/.exec(s);
    if (m) { year = Number(m[1]); month = Number(m[2]); day = Number(m[3]); }
    else if ((m = /^-{0,2}(\d{1,2})-(\d{1,2})$/.exec(s))) { month = Number(m[1]); day = Number(m[2]); }
    else throw new ClientDetailError('Birthday must be a date like 1990-03-04, or --03-04 without a year');
  }
  const thisYear = new Date().getUTCFullYear();
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new ClientDetailError('Birthday month is not valid');
  if (year != null && (!Number.isInteger(year) || year < 1900 || year > thisYear)) throw new ClientDetailError('Birthday year is not valid');
  if (!Number.isInteger(day) || day < 1 || day > daysIn(month, year)) throw new ClientDetailError('Birthday day is not valid');
  return { month, day, year };
}

const pad = (n) => String(n).padStart(2, '0');
export function formatBirthday(row) {
  if (!row || !row.birth_month || !row.birth_day) return null;
  const md = `${pad(row.birth_month)}-${pad(row.birth_day)}`;
  return row.birth_year ? `${row.birth_year}-${md}` : `--${md}`;
}

// One line for the legacy clients.address column (old app builds and the
// client portal read it): "12 Oak St, Austin, TX 78701, United States".
export function formatAddress(p) {
  if (!p) return null;
  const regionLine = [p.region, p.postalCode].filter(Boolean).join(' ');
  const s = [p.street, p.city, regionLine, p.country].filter(Boolean).join(', ');
  return s ? s.slice(0, 500) : null;
}

export function serializeClientDetails(row) {
  const parts = {
    street: row.address_street || null,
    city: row.address_city || null,
    region: row.address_region || null,
    postalCode: row.address_postal_code || null,
    country: row.address_country || null,
  };
  const hasParts = Object.values(parts).some(Boolean);
  const em = {
    name: row.emergency_name || null,
    phone: row.emergency_phone || null,
    relationship: row.emergency_relationship || null,
  };
  return {
    addressParts: hasParts ? parts : null,
    birthday: formatBirthday(row),
    pronouns: row.pronouns || null,
    emergencyContact: em.name || em.phone || em.relationship ? em : null,
    preferredContact: row.preferred_contact || null,
    occupation: row.occupation || null,
    customFields: row.custom_fields && typeof row.custom_fields === 'object' && !Array.isArray(row.custom_fields)
      ? row.custom_fields : {},
  };
}

// Reads the detail keys present in `body` and returns the column values to
// write: { cols: { column: value }, customPatch, errors: [] }.
//   lenient: false (owner forms, Ivy): a bad value is an error.
//   lenient: true  (imports): a bad value is dropped and reported in
//            `asWritten` ("Birthday as written: 31/02/1990") so the caller
//            can keep it in notes instead of losing it.
// The legacy one-line `address` (old app builds, the client portal) is
// handled by the callers; addressParts here also rewrites `address`.
export function clientDetailColumns(body, { lenient = false } = {}) {
  const cols = {};
  const errors = [];
  const asWritten = [];
  const b = body && typeof body === 'object' ? body : {};
  const fail = (msg, label, raw) => {
    if (lenient) { if (raw != null && String(raw).trim()) asWritten.push(`${label} as written: ${String(raw).slice(0, 120)}`); }
    else errors.push(msg);
  };

  if ('addressParts' in b) {
    const p = b.addressParts && typeof b.addressParts === 'object' ? b.addressParts : {};
    const parts = {};
    for (const [k, col] of Object.entries(ADDRESS_COLS)) {
      parts[k] = clean(p[k], DETAIL_LIMITS[k]);
      cols[col] = parts[k];
    }
    cols.address = formatAddress(parts);
  }
  if ('birthday' in b) {
    try {
      const d = parseBirthday(b.birthday);
      cols.birth_month = d ? d.month : null;
      cols.birth_day = d ? d.day : null;
      cols.birth_year = d ? d.year : null;
    } catch (e) { fail(e.message, 'Birthday', b.birthday); }
  }
  if ('pronouns' in b) cols.pronouns = clean(b.pronouns, DETAIL_LIMITS.pronouns);
  if ('occupation' in b) cols.occupation = clean(b.occupation, DETAIL_LIMITS.occupation);
  if ('preferredContact' in b) {
    const v = b.preferredContact == null || b.preferredContact === '' ? null : String(b.preferredContact).toLowerCase();
    if (v === null || PREFERRED_CONTACT.includes(v)) cols.preferred_contact = v;
    else fail('Preferred contact must be email, text or call', 'Preferred contact', b.preferredContact);
  }
  if ('emergencyContact' in b) {
    const e = b.emergencyContact && typeof b.emergencyContact === 'object' ? b.emergencyContact : {};
    cols.emergency_name = clean(e.name, DETAIL_LIMITS.emergencyName);
    cols.emergency_phone = clean(e.phone, DETAIL_LIMITS.emergencyPhone);
    cols.emergency_relationship = clean(e.relationship, DETAIL_LIMITS.emergencyRelationship);
  }
  return { cols, errors, asWritten };
}

// ── Custom fields ─────────────────────────────────────────────────────

export function serializeFieldDef(r) {
  return {
    id: r.id,
    label: r.label,
    type: r.type,
    options: Array.isArray(r.options) ? r.options : [],
    position: r.position,
  };
}

export async function loadFieldDefs(workspaceId) {
  const { rows } = await sql`
    SELECT id, label, type, options, position FROM client_field_definitions
     WHERE workspace_id = ${workspaceId}
     ORDER BY position ASC, created_at ASC
     LIMIT ${CUSTOM_FIELD_MAX * 2}`;
  return rows.map(serializeFieldDef);
}

// Validates a field definition from the owner (create or edit).
export function cleanFieldDef(body, { partial = false } = {}) {
  const out = {};
  if (!partial || 'label' in body) {
    const label = clean(body.label, 200);
    if (!label) throw new ClientDetailError('Give the field a name');
    if (label.length > CUSTOM_LABEL_MAX) throw new ClientDetailError(`Field names can be up to ${CUSTOM_LABEL_MAX} characters`);
    out.label = label;
  }
  if (!partial) {
    if (!CUSTOM_FIELD_TYPES.includes(body.type)) throw new ClientDetailError('Pick a field type');
    out.type = body.type;
  }
  if ('options' in body || (!partial && out.type === 'select')) {
    const raw = Array.isArray(body.options) ? body.options : [];
    if (raw.length > CUSTOM_OPTIONS_MAX) throw new ClientDetailError(`A dropdown can have up to ${CUSTOM_OPTIONS_MAX} choices`);
    const seen = new Set();
    const opts = [];
    for (const o of raw) {
      const v = clean(o, 200);
      if (!v) continue;
      if (v.length > CUSTOM_OPTION_MAX) throw new ClientDetailError(`Choices can be up to ${CUSTOM_OPTION_MAX} characters`);
      if (seen.has(v.toLowerCase())) continue;
      seen.add(v.toLowerCase());
      opts.push(v);
    }
    out.options = opts;
  }
  return out;
}

// One value checked against its definition. Returns the value to store,
// null to clear, or throws ClientDetailError.
export function cleanCustomValue(def, v) {
  if (v == null || v === '') return null;
  switch (def.type) {
    case 'text': {
      const s = String(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
      return s ? s.slice(0, CUSTOM_TEXT_MAX) : null;
    }
    case 'number': {
      const n = typeof v === 'number' ? v : Number(String(v).replace(/[,\s]/g, ''));
      if (!Number.isFinite(n) || Math.abs(n) > 1e12) throw new ClientDetailError(`${def.label} must be a number`);
      return n;
    }
    case 'date': {
      const s = String(v).trim();
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
      const ok = m && Number(m[2]) >= 1 && Number(m[2]) <= 12 && Number(m[3]) >= 1 && Number(m[3]) <= daysIn(Number(m[2]), Number(m[1]));
      if (!ok) throw new ClientDetailError(`${def.label} must be a date like 2026-03-04`);
      return s;
    }
    case 'boolean': {
      if (typeof v === 'boolean') return v;
      const s = String(v).trim().toLowerCase();
      if (['yes', 'y', 'true', '1', 'x'].includes(s)) return true;
      if (['no', 'n', 'false', '0'].includes(s)) return false;
      throw new ClientDetailError(`${def.label} must be yes or no`);
    }
    case 'select': {
      const s = String(v).trim().toLowerCase();
      const hit = (def.options || []).find((o) => o.toLowerCase() === s);
      if (!hit) throw new ClientDetailError(`${def.label} must be one of its choices`);
      return hit;
    }
    default:
      return null;
  }
}

// Merges a { fieldId: value } patch into the stored values. Unknown ids are
// ignored (a field deleted meanwhile), null/'' removes a value, and values
// for fields that no longer exist are dropped. lenient: bad values are
// reported in asWritten instead of failing.
export function mergeCustomFields(stored, patch, defs, { lenient = false } = {}) {
  const byId = new Map(defs.map((d) => [d.id, d]));
  const out = {};
  const src = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  for (const [k, v] of Object.entries(src)) if (byId.has(k)) out[k] = v;
  const errors = [];
  const asWritten = [];
  const p = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
  for (const [k, raw] of Object.entries(p).slice(0, CUSTOM_FIELD_MAX * 2)) {
    const def = byId.get(k);
    if (!def) continue;
    try {
      const v = cleanCustomValue(def, raw);
      if (v === null) delete out[k]; else out[k] = v;
    } catch (e) {
      if (lenient) asWritten.push(`${def.label}: ${String(raw).slice(0, 200)}`);
      else errors.push(e.message);
    }
  }
  if (JSON.stringify(out).length > CUSTOM_JSON_MAX) errors.push('Custom field values are too long');
  return { values: out, errors, asWritten };
}

// Ivy tools speak snake_case; turn their arguments into the API body shape.
export function ivyDetailsToBody(a = {}) {
  const body = {};
  if (a.address && typeof a.address === 'object') {
    body.addressParts = {
      street: a.address.street, city: a.address.city, region: a.address.region,
      postalCode: a.address.postal_code, country: a.address.country,
    };
  }
  if ('birthday' in a) body.birthday = a.birthday;
  if ('pronouns' in a) body.pronouns = a.pronouns;
  if ('occupation' in a) body.occupation = a.occupation;
  if ('preferred_contact' in a) body.preferredContact = a.preferred_contact;
  if (a.emergency_contact && typeof a.emergency_contact === 'object') body.emergencyContact = a.emergency_contact;
  return body;
}

// JSON schema pieces for the Ivy client tools.
export const IVY_DETAIL_PROPS = {
  birthday: { type: 'string', description: "YYYY-MM-DD, or --MM-DD when the year isn't known." },
  address: {
    type: 'object',
    properties: { street: { type: 'string' }, city: { type: 'string' }, region: { type: 'string', description: 'State, province or region.' }, postal_code: { type: 'string' }, country: { type: 'string' } },
  },
  pronouns: { type: 'string', description: 'Gender or pronouns, as the owner gave them.' },
  emergency_contact: {
    type: 'object',
    properties: { name: { type: 'string' }, phone: { type: 'string' }, relationship: { type: 'string' } },
  },
  preferred_contact: { type: 'string', description: "'email', 'text' or 'call'." },
  occupation: { type: 'string', description: 'Company or occupation.' },
};

// UPDATE helper for a single client: writes the given columns (already
// validated) scoped by workspace. Returns the fresh row.
export async function writeClientColumns(id, workspaceId, cols) {
  const keys = Object.keys(cols);
  if (!keys.length) return null;
  const values = [];
  const sets = keys.map((k) => {
    values.push(k === 'custom_fields' ? JSON.stringify(cols[k]) : cols[k]);
    return `${k} = $${values.length}${k === 'custom_fields' ? '::jsonb' : ''}`;
  });
  values.push(id, workspaceId);
  const { rows } = await sql.query(
    `UPDATE clients SET ${sets.join(', ')}, updated_at = NOW()
      WHERE id = $${values.length - 1} AND workspace_id = $${values.length}
      RETURNING *`, values);
  return rows[0] || null;
}

// Column names written by clientDetailColumns; a fixed allow-list so the
// dynamic UPDATE/INSERT builders never take a name from a request.
export const DETAIL_COLUMNS = [
  'address', 'address_street', 'address_city', 'address_region', 'address_postal_code', 'address_country',
  'birth_month', 'birth_day', 'birth_year', 'pronouns', 'occupation', 'preferred_contact',
  'emergency_name', 'emergency_phone', 'emergency_relationship',
];

// Workspace's date order for ambiguous dates like 03/04/1990: month first
// in the US (the default) and the few places that write dates that way,
// day first everywhere else. From the onboarding "where are you based".
const MDY_COUNTRIES = new Set(['united states', 'us', 'usa', 'u.s.', 'philippines', 'canada', 'belize', 'micronesia', 'palau', 'marshall islands', 'puerto rico', 'guam']);
export async function workspaceDateOrder(workspaceId) {
  try {
    const { rows } = await sql`SELECT location_state, location_country FROM workspace_profile WHERE workspace_id = ${workspaceId} LIMIT 1`;
    const p = rows[0];
    if (!p || p.location_state) return 'mdy';
    const c = String(p.location_country || '').trim().toLowerCase();
    if (!c) return 'mdy';
    return MDY_COUNTRIES.has(c) ? 'mdy' : 'dmy';
  } catch {
    return 'mdy';
  }
}

// Creates one definition under the per-business cap. Throws
// ClientDetailError (cap, duplicate name, bad input).
export async function createFieldDef(workspaceId, body) {
  const def = cleanFieldDef(body);
  const cur = await sql`SELECT COUNT(*)::int AS n, COALESCE(MAX(position), -1)::int AS maxpos
    FROM client_field_definitions WHERE workspace_id = ${workspaceId}`;
  if (cur.rows[0].n >= CUSTOM_FIELD_MAX) throw new ClientDetailError(`You can have up to ${CUSTOM_FIELD_MAX} custom fields`);
  try {
    const { rows } = await sql`
      INSERT INTO client_field_definitions (workspace_id, label, type, options, position)
      VALUES (${workspaceId}, ${def.label}, ${def.type}, ${JSON.stringify(def.options || [])}::jsonb, ${cur.rows[0].maxpos + 1})
      RETURNING id, label, type, options, position`;
    return serializeFieldDef(rows[0]);
  } catch (e) {
    if (e.code === '23505') throw new ClientDetailError(`You already have a field called "${def.label}"`);
    throw e;
  }
}

// For imports: makes sure each { ref, label, type } exists, reusing a
// field with the same name. Returns { byRef: Map(ref → def), defs }.
// Checks the cap for the whole batch before creating anything.
export async function ensureFieldDefs(workspaceId, list) {
  const wanted = (Array.isArray(list) ? list : []).slice(0, CUSTOM_FIELD_MAX + 1);
  let defs = await loadFieldDefs(workspaceId);
  const byLabel = new Map(defs.map((d) => [d.label.toLowerCase(), d]));
  const toCreate = [];
  const seen = new Set();
  for (const f of wanted) {
    if (!clean(f?.ref, 80)) continue;
    const d = cleanFieldDef({ label: f.label, type: CUSTOM_FIELD_TYPES.includes(f.type) ? f.type : 'text', options: f.options });
    const key = d.label.toLowerCase();
    if (byLabel.has(key) || seen.has(key)) continue;
    seen.add(key);
    toCreate.push(d);
  }
  if (defs.length + toCreate.length > CUSTOM_FIELD_MAX) {
    throw new ClientDetailError(`You can have up to ${CUSTOM_FIELD_MAX} custom fields. Keep fewer columns as fields, or add them to notes.`);
  }
  for (const d of toCreate) {
    const made = await createFieldDef(workspaceId, d);
    byLabel.set(made.label.toLowerCase(), made);
  }
  if (toCreate.length) defs = await loadFieldDefs(workspaceId);
  const byRef = new Map();
  for (const f of wanted) {
    const ref = clean(f?.ref, 80);
    const label = clean(f?.label, CUSTOM_LABEL_MAX);
    if (ref && label && byLabel.has(label.toLowerCase())) byRef.set(ref, byLabel.get(label.toLowerCase()));
  }
  return { byRef, defs };
}
