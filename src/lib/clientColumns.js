// Client-list file helpers shared by the import hub: a forgiving CSV parser
// and column auto-detection tuned for the exports owners bring over from
// other booking apps (Square, Acuity, Vagaro, GlossGenius, Booksy,
// Calendly, Mindbody, Fresha, and trainer apps like PTminder, FutureForm
// and Momence), Google Contacts, and hand-made spreadsheets.
//
// For PTminder, FutureForm and Momence we could not confirm the exact export
// column names from their public help pages, so they rely on the generic
// header detection below (Status, Client Status, Membership Status, Date of
// Birth, DOB, Emergency Contact, Address 1, Suburb, Postcode and the like),
// not on an app-specific template.
//
// Pure functions with no DOM or React, so tests/client-columns.test.mjs can
// run them under plain node.
//
// Nothing here renders anything: callers show cell values as React text,
// never as HTML.

export const CSV_MAX_BYTES = 5 * 1024 * 1024;
export const CSV_MAX_ROWS = 2000;   // same cap as POST /api/clients/import
const MAX_COLS = 200;
const MAX_CELL = 4000;
const STATUS_VALUES_MAX = 40;       // distinct statuses shown in the mapping table

// Canonical fields a column can map to. 'firstName' / 'lastName' are joined
// into `name` when there is no full-name column. 'nameLastFirst' is a single
// column written "Doe, Jane" (some report exports do this).
export const CLIENT_FIELDS = [
  'name', 'firstName', 'lastName', 'nameLastFirst', 'email', 'phone', 'stage', 'notes', 'source', 'tags',
  'street', 'street2', 'city', 'region', 'postalCode', 'country', 'birthday', 'pronouns',
  'emergencyName', 'emergencyPhone', 'emergencyRelationship', 'occupation', 'preferredContact',
];

// Column actions that are not a single field:
//   KEEP_NOTES        add "Header: value" to the client's notes
//   KEEP_NEW_FIELD    keep as a new custom field named after the header
//   'custom:<id>'     an existing custom field
export const KEEP_NOTES = 'keep:notes';
export const KEEP_NEW_FIELD = 'keep:field';
export const CUSTOM_PREFIX = 'custom:';

// Exact header matches after normalising (lower case, punctuation to
// spaces). Order inside each list does not matter; order of FIELD_ORDER
// below decides which field wins when two could claim a column.
const ALIASES = {
  name: [
    'name', 'full name', 'fullname', 'client name', 'client', 'client full name',
    'customer name', 'customer', 'customer full name', 'contact name', 'contact',
    'display name', 'invitee name', 'invitee', 'member name', 'patient name',
    'guest name', 'student name', 'attendee name',
  ],
  firstName: [
    'first name', 'firstname', 'first', 'given name', 'givenname', 'fname', 'forename',
    'client first name', 'customer first name', 'invitee first name', 'contact first name', 'member first name',
  ],
  lastName: [
    'last name', 'lastname', 'last', 'surname', 'family name', 'familyname', 'lname',
    'client last name', 'customer last name', 'invitee last name', 'contact last name', 'member last name',
  ],
  nameLastFirst: ['last name first name', 'last first', 'name last first'],
  email: [
    'email', 'e mail', 'email address', 'e mail address', 'emailaddress', 'mail',
    'client email', 'customer email', 'invitee email', 'contact email', 'primary email',
    'email 1', 'email1', 'e mail 1 value', 'email 1 value', 'personal email', 'member email',
  ],
  phone: [
    'mobile', 'mobile phone', 'mobile number', 'mobile phone number', 'cell', 'cell phone',
    'cell number', 'cellphone', 'text message number', 'text reminder number', 'sms number',
    'phone', 'phone number', 'phonenumber', 'telephone', 'tel', 'primary phone',
    'client phone', 'customer phone', 'invitee phone', 'contact phone', 'phone 1',
    'phone 1 value', 'home phone', 'work phone', 'business phone', 'other phone', 'member phone',
  ],
  stage: [
    'stage', 'status', 'client status', 'customer status', 'member status', 'membership status',
    'account status', 'contact status', 'lead status', 'active', 'is active', 'active status',
    'active inactive', 'client type', 'contact type', 'customer type', 'lifecycle stage', 'client stage',
  ],
  notes: [
    'notes', 'note', 'client notes', 'customer notes', 'client note', 'customer note',
    'memo', 'comments', 'comment', 'description', 'additional info', 'additional information',
    'staff notes', 'private notes', 'alert notes', 'trainer notes', 'coach notes', 'general notes',
  ],
  source: ['source', 'lead source', 'how they found you', 'how did you hear about us', 'referral source', 'referral', 'referred by', 'how did you hear about us?'],
  tags: ['tags', 'tag', 'labels', 'label', 'groups', 'group'],
  street: [
    'address', 'street', 'street address', 'street address 1', 'street address line 1', 'address 1', 'address1',
    'address line 1', 'address line1', 'home address', 'mailing address', 'postal address', 'street 1',
    'billing address', 'billing address 1', 'address street',
  ],
  street2: ['address 2', 'address2', 'address line 2', 'street address 2', 'street 2', 'apartment', 'unit', 'suite', 'apt'],
  city: ['city', 'town', 'suburb', 'city town', 'town city', 'locality', 'billing city', 'address city', 'city suburb', 'suburb city'],
  region: ['state', 'province', 'region', 'state province', 'state region', 'county', 'state code', 'billing state', 'address state', 'state province region'],
  postalCode: ['zip', 'zip code', 'zipcode', 'postcode', 'post code', 'postal code', 'postalcode', 'zip postal code', 'postal zip code', 'billing zip', 'address zip', 'address postcode'],
  country: ['country', 'country region', 'billing country', 'address country'],
  birthday: [
    'birthday', 'birth date', 'birthdate', 'date of birth', 'dob', 'd o b', 'bday', 'b day', 'born',
    'birth day', 'client birthday', 'customer birthday', 'member birthday', 'date of birth dob',
  ],
  pronouns: ['gender', 'sex', 'pronouns', 'pronoun', 'gender identity', 'gender pronouns', 'preferred pronouns'],
  emergencyName: [
    'emergency contact', 'emergency contact name', 'emergency name', 'emergency contact person', 'ice contact',
    'ice name', 'in case of emergency', 'emergency contact full name', 'next of kin',
  ],
  emergencyPhone: [
    'emergency contact phone', 'emergency phone', 'emergency contact number', 'emergency number',
    'emergency contact phone number', 'emergency contact mobile', 'ice phone', 'ice number', 'next of kin phone',
  ],
  emergencyRelationship: [
    'emergency contact relationship', 'emergency relationship', 'relationship', 'emergency contact relation',
    'relationship to client', 'relation', 'next of kin relationship',
  ],
  occupation: ['occupation', 'company', 'company name', 'employer', 'job', 'job title', 'profession', 'work', 'organization', 'organisation'],
  preferredContact: ['preferred contact', 'preferred contact method', 'contact preference', 'contact method', 'preferred method of contact', 'best way to contact'],
};

const FIELD_ORDER = [
  'emergencyPhone', 'emergencyRelationship', 'emergencyName',
  'email', 'phone', 'nameLastFirst', 'firstName', 'lastName', 'name', 'notes', 'stage', 'source', 'tags',
  'birthday', 'street', 'street2', 'city', 'region', 'postalCode', 'country', 'pronouns', 'occupation', 'preferredContact',
];

// When several columns could be the phone, the earliest pattern in this list
// wins (a mobile number beats a home or work line: it can get texts).
const PHONE_PRIORITY = ['mobile', 'cell', 'text', 'sms', 'primary', 'phone', 'tel'];
const PHONE_SECONDARY = /\b(home|work|business|office|other|landline)\b/;

// Words that mean "this column is ABOUT the email/phone, not the email/phone
// itself", e.g. Square's "Email Subscription Status".
const NOT_A_VALUE = /\b(status|subscri\w*|opt|opted|consent|marketing|verified|unsubscribed|bounced?|type|count|date|label|preference|allowed|valid|reminders?|fax|pager)\b/;

export function normalizeHeader(h) {
  return String(h == null ? '' : h)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .slice(0, 80);
}

function fuzzyField(norm) {
  if (!norm) return '';
  const words = norm.split(' ');
  const has = (w) => words.includes(w);
  // Emergency contact columns name a phone or a person, so they go first.
  if (has('emergency') || has('ice') || (has('next') && has('kin'))) {
    if (has('phone') || has('mobile') || has('number') || has('cell') || has('tel')) return 'emergencyPhone';
    if (has('relationship') || has('relation')) return 'emergencyRelationship';
    if (has('email')) return '';
    return 'emergencyName';
  }
  // "Client Status", "Membership Status" (not "Email Subscription Status").
  if (has('status') && ['client', 'member', 'membership', 'customer', 'account', 'contact'].some(has)
    && !['email', 'sms', 'text', 'marketing', 'subscription', 'payment', 'invoice', 'booking', 'appointment'].some(has)) {
    return 'stage';
  }
  if ((has('birth') || has('birthday') || has('dob')) && !has('year') && !has('place')) return 'birthday';
  if (NOT_A_VALUE.test(norm)) return '';
  if (has('email') || has('e') && has('mail')) return 'email';
  if (has('mobile') || has('cell') || has('phone') || has('telephone')) return 'phone';
  if (has('first') && has('name')) return 'firstName';
  if ((has('last') || has('family')) && has('name')) return 'lastName';
  if (has('notes') || has('note')) return 'notes';
  if (has('zip') || has('postcode') || has('postal')) return 'postalCode';
  if (has('address') && (has('2') || has('line2'))) return 'street2';
  if (has('address') || has('street')) return 'street';
  if (has('city') || has('suburb') || has('town')) return 'city';
  if (has('province') || has('state')) return 'region';
  if (has('country')) return 'country';
  if (has('gender') || has('pronouns')) return 'pronouns';
  return '';
}

function phoneRank(norm) {
  if (PHONE_SECONDARY.test(norm)) return PHONE_PRIORITY.length + 1;
  const i = PHONE_PRIORITY.findIndex((p) => norm.includes(p));
  return i === -1 ? PHONE_PRIORITY.length : i;
}

// detectColumns(headers) → mapping array, one canonical field (or '') per
// header. Each field is claimed by at most one column.
export function detectColumns(headers) {
  const list = Array.isArray(headers) ? headers.slice(0, MAX_COLS) : [];
  const norms = list.map(normalizeHeader);
  const mapping = norms.map(() => '');
  const claimed = new Set();

  const claim = (field, idx) => {
    if (claimed.has(field) || mapping[idx]) return false;
    mapping[idx] = field;
    claimed.add(field);
    return true;
  };

  // Pass 1: exact aliases, field by field in priority order.
  for (const field of FIELD_ORDER) {
    const aliases = ALIASES[field];
    const hits = [];
    norms.forEach((n, idx) => { if (!mapping[idx] && aliases.includes(n)) hits.push(idx); });
    if (!hits.length) continue;
    if (field === 'phone') hits.sort((a, b) => phoneRank(norms[a]) - phoneRank(norms[b]) || a - b);
    claim(field, hits[0]);
  }

  // Pass 2: looser matches for the columns still unmapped ("Client Email
  // Address", "Mobile Phone (primary)", "Customer First Name").
  const loose = [];
  norms.forEach((n, idx) => {
    if (mapping[idx]) return;
    const f = fuzzyField(n);
    if (f) loose.push({ idx, f });
  });
  loose.sort((a, b) => (a.f === 'phone' && b.f === 'phone')
    ? phoneRank(norms[a.idx]) - phoneRank(norms[b.idx]) || a.idx - b.idx
    : a.idx - b.idx);
  for (const { idx, f } of loose) claim(f, idx);

  // A full-name column plus first/last columns: keep all three; buildRows
  // uses the full name and falls back to first + last when it is blank.
  return mapping;
}

// Columns nothing claimed: match a custom field of the same name, else keep
// them in notes when they hold anything, so no column is silently dropped.
// The owner can switch each one to "new custom field" or "leave out".
// The other app's own record ids ("Client ID", "Member ID") start as left
// out (listed in the preview) since they mean nothing in Ivy.
const SYSTEM_ID = /^(id|uuid|guid|(.+ )?(id|uuid|guid|number|no|ref|reference))$/;
export function defaultKeeps(headers, mapping, records, customFields = []) {
  const byLabel = new Map((customFields || []).map((f) => [normalizeHeader(f.label), f.id]));
  const used = new Set(mapping.filter((m) => m && m.startsWith(CUSTOM_PREFIX)));
  return mapping.map((m, i) => {
    if (m) return m;
    const norm = normalizeHeader(headers[i]);
    const id = norm && byLabel.get(norm);
    if (id && !used.has(CUSTOM_PREFIX + id)) { used.add(CUSTOM_PREFIX + id); return CUSTOM_PREFIX + id; }
    const filled = (records || []).some((r) => String(r[i] || '').trim() !== '');
    return filled && norm && !SYSTEM_ID.test(norm) ? KEEP_NOTES : '';
  });
}

// Pick a delimiter by counting candidates in the first line outside quotes.
function sniffDelimiter(text) {
  const end = Math.min(text.length, 20000);
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let inQ = false;
  for (let i = 0; i < end; i++) {
    const c = text[i];
    if (c === '"') inQ = !inQ;
    else if (!inQ && (c === '\n' || c === '\r')) break;
    else if (!inQ && c in counts) counts[c]++;
  }
  if (counts['\t'] > counts[','] && counts['\t'] >= counts[';']) return '\t';
  if (counts[';'] > counts[',']) return ';';
  return ',';
}

// parseCSVRecords(text) → array of string arrays. Handles quoted fields with
// embedded delimiters and newlines, doubled quotes, CRLF/LF/CR, a BOM, and
// comma, semicolon or tab delimiters. Linear time; caps rows, columns and
// cell length so a hostile file cannot blow up memory.
export function parseCSVRecords(input, { maxRows = CSV_MAX_ROWS + 20 } = {}) {
  let text = String(input == null ? '' : input);
  if (text.length > CSV_MAX_BYTES) text = text.slice(0, CSV_MAX_BYTES);
  text = text.replace(/^\uFEFF/, '');
  if (!text.trim()) return [];
  const delim = sniffDelimiter(text);

  const out = [];
  let cur = [];
  let field = '';
  let inQuotes = false;
  const pushField = () => {
    if (cur.length < MAX_COLS) cur.push(field.length > MAX_CELL ? field.slice(0, MAX_CELL) : field);
    field = '';
  };
  const pushRecord = () => {
    pushField();
    if (cur.some((v) => v.trim() !== '')) out.push(cur);
    cur = [];
  };
  for (let i = 0; i < text.length; i++) {
    if (out.length >= maxRows) break;
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else if (field.length <= MAX_CELL) field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === delim) {
      pushField();
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      pushRecord();
    } else if (field.length <= MAX_CELL) {
      field += c;
    }
  }
  if (out.length < maxRows && (field !== '' || cur.length > 0)) pushRecord();
  return out;
}

// Some report exports put a title line or two above the real header row
// ("Customer List Report", a date range). Use the first of the top rows
// that has a recognisable name or email column.
function findHeaderRow(records) {
  const limit = Math.min(records.length, 10);
  for (let r = 0; r < limit; r++) {
    const m = detectColumns(records[r]);
    if (m.includes('email') || m.includes('name') || m.includes('firstName') || m.includes('nameLastFirst')) return r;
  }
  return 0;
}

// parseClientCSV(text) → { headers, mapping, records }. records are the
// raw rows under the header (trimmed cells), still unmapped, so the owner
// can fix a column and we re-apply.
export function parseClientCSV(input) {
  const all = parseCSVRecords(input);
  if (!all.length) return { headers: [], mapping: [], records: [] };
  const h = findHeaderRow(all);
  const headers = all[h].map((x) => String(x || '').trim());
  const mapping = detectColumns(headers);
  const records = all.slice(h + 1, h + 1 + CSV_MAX_ROWS).map((cells) => cells.map((c) => String(c || '').trim()));
  return { headers, mapping, records };
}

const EMAIL_TOKEN = /[^\s,;<>()"']+@[^\s,;<>()"']+\.[^\s,;<>()"']+/;
export const STAGES = ['active', 'lead', 'paused'];
const VALID_STAGES = new Set(STAGES);

export function firstEmail(v) {
  const m = String(v || '').slice(0, 500).match(EMAIL_TOKEN);
  return m ? m[0].toLowerCase().slice(0, 254) : '';
}

// Keep what the owner typed (the server normalises phone numbers); just
// trim, take the first number when a cell holds several, and cap length.
export function cleanPhone(v) {
  const s = String(v || '').split(/[,;/|]| or /i)[0].trim();
  if (!/\d/.test(s)) return '';
  return s.replace(/^tel:/i, '').slice(0, 40);
}

function cleanText(v, max) {
  // Strip control characters a spreadsheet can carry (keep newlines in notes).
  // eslint-disable-next-line no-control-regex
  return String(v || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);
}

function flipLastFirst(v) {
  const s = cleanText(v, 200);
  const i = s.indexOf(',');
  if (i <= 0) return s;
  const last = s.slice(0, i).trim();
  const first = s.slice(i + 1).trim();
  return first ? `${first} ${last}` : last;
}

// ── Status → stage ────────────────────────────────────────────────────

// Ivy has three stages: active, lead and paused. "Paused" is where
// inactive, former, cancelled and archived clients go (Clients > Paused).
const STAGE_WORDS = {
  active: ['active', 'current', 'member', 'active member', 'active client', 'client', 'customer', 'enrolled',
    'ongoing', 'regular', 'paying', 'subscribed', 'yes', 'y', 'true', '1', 'live', 'open', 'existing', 'recurring'],
  lead: ['lead', 'leads', 'prospect', 'prospective', 'enquiry', 'inquiry', 'trial', 'free trial', 'intro', 'new lead',
    'potential', 'interested', 'pending', 'not started', 'new', 'contact', 'opportunity', 'consult', 'consultation',
    'waitlist', 'wait list', 'invited', 'unconverted'],
  paused: ['inactive', 'paused', 'pause', 'on hold', 'hold', 'frozen', 'freeze', 'suspended', 'former', 'past',
    'lapsed', 'expired', 'cancelled', 'canceled', 'cancel', 'archived', 'archive', 'ended', 'left', 'churned', 'lost',
    'no', 'n', 'false', '0', 'closed', 'deactivated', 'dormant', 'not active', 'terminated', 'deleted', 'old',
    'past client', 'former client', 'former member', 'non member', 'nonmember', 'stopped', 'finished', 'completed', 'blocked'],
};
const STAGE_BY_WORD = new Map();
for (const [stage, words] of Object.entries(STAGE_WORDS)) for (const w of words) STAGE_BY_WORD.set(w, stage);

export function statusKey(v) {
  return normalizeHeader(v);
}

// suggestStage('Inactive') → 'paused'; unknown → null.
export function suggestStage(value) {
  const k = statusKey(value);
  if (!k) return null;
  if (STAGE_BY_WORD.has(k)) return STAGE_BY_WORD.get(k);
  // Longer labels: "Inactive - moved away", "Active (12 sessions)".
  if (/\b(inactive|in active|not active|cancel+ed|cancel|expired|archived?|former|paused?|on hold|frozen|lapsed|suspended|churned|terminated)\b/.test(k)) return 'paused';
  if (/\b(lead|prospect|trial|enquiry|inquiry|intro)\b/.test(k)) return 'lead';
  if (/\b(active|current|member|enrolled)\b/.test(k)) return 'active';
  return null;
}

// The distinct values of the status column with counts, for the mapping
// table: [{ key, label, count, suggested }], biggest first. Blank cells
// are one entry with key ''. At most STATUS_VALUES_MAX entries; rarer
// values beyond that follow the "anything else" choice.
export function statusSummary(records, mapping) {
  const col = (mapping || []).indexOf('stage');
  if (col === -1) return [];
  const m = new Map();
  for (const cells of records || []) {
    const raw = cleanText(cells[col], 80);
    const key = statusKey(raw);
    const e = m.get(key);
    if (e) e.count++;
    else m.set(key, { key, label: raw, count: 1, suggested: key ? suggestStage(raw) : null });
  }
  return [...m.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)).slice(0, STATUS_VALUES_MAX);
}

// Default status map: every known value to its suggested stage. Unknown
// and blank values are left out, so they follow the owner's "anything
// else" pick.
export function defaultStatusMap(summary) {
  const out = {};
  for (const s of summary || []) if (s.key && s.suggested) out[s.key] = s.suggested;
  return out;
}

// ── Dates ─────────────────────────────────────────────────────────────

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function monthFromName(s) {
  const k = String(s || '').toLowerCase().replace(/\.$/, '');
  if (k.length < 3) return 0;
  const i = MONTHS.findIndex((m) => k.startsWith(m) && ('january february march april may june july august september sept october november december'.includes(k)));
  return i + 1;
}
function daysIn(month, year) {
  if (month === 2) return year && !(year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? 28 : 29;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}
function fullYear(y, now) {
  if (y == null) return null;
  const n = Number(y);
  if (String(y).length === 2) {
    const yy = now.getFullYear() % 100;
    return n > yy ? 1900 + n : 2000 + n;
  }
  return n;
}

// parseDateLoose('03/04/1990', 'mdy') → { month: 3, day: 4, year: 1990,
// ambiguous: true }. order ('mdy' | 'dmy') only decides dates where both
// numbers could be the month. Handles 1990-03-04, 1990/3/4, 3/4/90,
// 04.03.1990, March 4, 1990, 4 Mar 1990, 4-Mar-90, Mar 4 (no year), and a
// trailing time. Returns null when it cannot tell, or the date is not real.
// Linear, anchored regexes only.
export function parseDateLoose(value, order = 'mdy', { now = new Date(), birthday = true } = {}) {
  let s = String(value || '').trim().slice(0, 40).toLowerCase();
  if (!s) return null;
  s = s.replace(/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+/, '');
  let month = 0; let day = 0; let year = null; let ambiguous = false;
  let m;
  if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[t\s].*)?$/.exec(s))) {
    year = Number(m[1]); month = Number(m[2]); day = Number(m[3]);
  } else if ((m = /^(\d{1,2})[-/.](\d{1,2})(?:[-/.](\d{4}|\d{2}))?(?:\s.*)?$/.exec(s))) {
    const a = Number(m[1]); const b = Number(m[2]);
    year = fullYear(m[3], now);
    if (a > 12 && b <= 12) { day = a; month = b; }
    else if (b > 12 && a <= 12) { month = a; day = b; }
    else {
      ambiguous = a !== b;
      if (order === 'dmy') { day = a; month = b; } else { month = a; day = b; }
    }
  } else if ((m = /^([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?(?:\s+(\d{4}|\d{2}))?$/.exec(s))) {
    month = monthFromName(m[1]); day = Number(m[2]); year = fullYear(m[3], now);
  } else if ((m = /^(\d{1,2})(?:st|nd|rd|th)?[\s-]+([a-z]{3,9})\.?,?(?:[\s-]+(\d{4}|\d{2}))?$/.exec(s))) {
    day = Number(m[1]); month = monthFromName(m[2]); year = fullYear(m[3], now);
  } else {
    return null;
  }
  // A two-digit birth year in the future means last century (3/4/30 → 1930).
  if (birthday && year && year > now.getFullYear()) year -= 100;
  if (!month || month < 1 || month > 12) return null;
  if (year != null && (year < 1900 || year > now.getFullYear() + (birthday ? 0 : 50))) return null;
  if (!day || day < 1 || day > daysIn(month, year)) return null;
  return { month, day, year, ambiguous };
}

const pad = (n) => String(n).padStart(2, '0');
// The API value: 'YYYY-MM-DD', or '--MM-DD' without a year.
export function dateToApi(d) {
  if (!d) return '';
  return d.year ? `${d.year}-${pad(d.month)}-${pad(d.day)}` : `--${pad(d.month)}-${pad(d.day)}`;
}
const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// 'Mar 4, 1990' or 'Mar 4' from an API birthday value.
export function birthdayLabel(v) {
  const m = /^(?:(\d{4})|-)-(\d{2})-(\d{2})$/.exec(String(v || ''));
  if (!m) return '';
  const label = `${MONTH_LABELS[Number(m[2]) - 1]} ${Number(m[3])}`;
  return m[1] ? `${label}, ${m[1]}` : label;
}

// How many birthday cells could be read either way (03/04/1990), so the
// preview can ask which order the file uses.
export function ambiguousDateCount(records, mapping) {
  const col = (mapping || []).indexOf('birthday');
  if (col === -1) return 0;
  let n = 0;
  for (const cells of records || []) {
    const d = parseDateLoose(cells[col], 'mdy');
    if (d && d.ambiguous) n++;
  }
  return n;
}

function preferredFrom(v) {
  const k = statusKey(v);
  if (!k) return '';
  if (/\b(e ?mail)\b/.test(k)) return 'email';
  if (/\b(text|sms|message|whatsapp)\b/.test(k)) return 'text';
  if (/\b(call|phone|ring)\b/.test(k)) return 'call';
  return '';
}

// ── Rows ──────────────────────────────────────────────────────────────

// buildClientRows(records, mapping, options) → { rows, dropped }.
// rows are what POST /api/clients/import takes; `sourceIndex` remembers the
// record a row came from (for the error download). dropped counts rows with
// no name we could use.
//   options.stage       stage for blank or unknown statuses (default 'lead')
//   options.statusMap   { statusKey: stage }; defaults to suggestStage
//   options.tags        tags for everyone
//   options.tagOldStatus  also tag each person with their old status text
//   options.dateOrder   'mdy' (default) or 'dmy' for dates like 03/04/1990
//   options.headers     column names, for "Header: value" notes and the
//                       refs of new custom fields ('col:<index>')
export function buildClientRows(records, mapping, defaults = {}) {
  const defaultTags = Array.isArray(defaults.tags) ? defaults.tags : [];
  const defaultStage = VALID_STAGES.has(defaults.stage) ? defaults.stage : 'lead';
  const statusMap = defaults.statusMap && typeof defaults.statusMap === 'object' ? defaults.statusMap : null;
  const order = defaults.dateOrder === 'dmy' ? 'dmy' : 'mdy';
  const headers = Array.isArray(defaults.headers) ? defaults.headers : [];
  const idx = {};
  const keepNotes = [];
  const customCols = [];
  (mapping || []).forEach((f, i) => {
    if (!f) return;
    if (f === KEEP_NOTES) keepNotes.push(i);
    else if (f === KEEP_NEW_FIELD) customCols.push({ i, key: `col:${i}` });
    else if (f.startsWith(CUSTOM_PREFIX)) customCols.push({ i, key: f.slice(CUSTOM_PREFIX.length) });
    else if (idx[f] === undefined) idx[f] = i;
  });
  const cell = (cells, f) => (idx[f] === undefined ? '' : String(cells[idx[f]] || '').trim());

  const rows = [];
  let dropped = 0;
  (records || []).forEach((cells, sourceIndex) => {
    let name = cleanText(cell(cells, 'name'), 120);
    if (!name && idx.nameLastFirst !== undefined) name = flipLastFirst(cell(cells, 'nameLastFirst')).slice(0, 120);
    if (!name) {
      name = [cleanText(cell(cells, 'firstName'), 60), cleanText(cell(cells, 'lastName'), 60)]
        .filter(Boolean).join(' ').slice(0, 120);
    }
    if (!name) { dropped++; return; }
    const row = { name, sourceIndex };
    const email = firstEmail(cell(cells, 'email'));
    if (email) row.email = email;
    const phone = cleanPhone(cell(cells, 'phone'));
    if (phone) row.phone = phone;

    const noteLines = [];
    const notes = cleanText(cell(cells, 'notes'), 4000);
    if (notes) noteLines.push(notes);
    for (const i of keepNotes) {
      const v = cleanText(cells[i], 1000);
      if (v) noteLines.push(`${cleanText(headers[i], 80) || `Column ${i + 1}`}: ${v}`);
    }
    if (noteLines.length) row.notes = noteLines.join('\n').slice(0, 4000);

    const source = cleanText(cell(cells, 'source'), 60);
    if (source) row.source = source;

    const rawStatus = cleanText(cell(cells, 'stage'), 80);
    const sKey = statusKey(rawStatus);
    let stage = null;
    if (sKey) stage = statusMap ? statusMap[sKey] : suggestStage(rawStatus);
    row.stage = VALID_STAGES.has(stage) ? stage : defaultStage;

    const tagCell = cell(cells, 'tags');
    const tags = tagCell ? tagCell.split(/[,;|]/).map((t) => cleanText(t, 40)).filter(Boolean) : [];
    if (defaults.tagOldStatus && rawStatus) tags.push(rawStatus.slice(0, 40));
    const allTags = Array.from(new Set([...tags, ...defaultTags])).slice(0, 20);
    if (allTags.length) row.tags = allTags;

    // Address: a second street line joins the first.
    const street = [cleanText(cell(cells, 'street'), 200), cleanText(cell(cells, 'street2'), 100)].filter(Boolean).join(', ');
    const parts = {
      street: street.slice(0, 200),
      city: cleanText(cell(cells, 'city'), 100),
      region: cleanText(cell(cells, 'region'), 100),
      postalCode: cleanText(cell(cells, 'postalCode'), 20),
      country: cleanText(cell(cells, 'country'), 80),
    };
    if (Object.values(parts).some(Boolean)) row.addressParts = parts;

    const bdayRaw = cleanText(cell(cells, 'birthday'), 40);
    if (bdayRaw) {
      const d = parseDateLoose(bdayRaw, order);
      // Unreadable dates go to the server as written; it keeps them in
      // notes ("Birthday as written: ...") instead of guessing.
      row.birthday = d ? dateToApi(d) : bdayRaw;
    }
    const pronouns = cleanText(cell(cells, 'pronouns'), 60);
    if (pronouns) row.pronouns = pronouns;
    const occupation = cleanText(cell(cells, 'occupation'), 120);
    if (occupation) row.occupation = occupation;
    const pref = preferredFrom(cell(cells, 'preferredContact'));
    if (pref) row.preferredContact = pref;
    const em = {
      name: cleanText(cell(cells, 'emergencyName'), 120),
      phone: cleanText(cell(cells, 'emergencyPhone'), 40),
      relationship: cleanText(cell(cells, 'emergencyRelationship'), 60),
    };
    if (em.name || em.phone || em.relationship) row.emergencyContact = em;

    if (customCols.length) {
      const cf = {};
      for (const { i, key } of customCols) {
        const v = cleanText(cells[i], 1000);
        if (v) cf[key] = v;
      }
      if (Object.keys(cf).length) row.customFields = cf;
    }
    rows.push(row);
  });
  return { rows, dropped };
}

// The custom fields to create for columns kept as "new custom field":
// [{ ref: 'col:<i>', label: header, type: 'text' }].
export function newFieldsFor(headers, mapping) {
  const out = [];
  const seen = new Set();
  (mapping || []).forEach((m, i) => {
    if (m !== KEEP_NEW_FIELD) return;
    let label = cleanText(headers[i], 50) || `Column ${i + 1}`;
    if (seen.has(label.toLowerCase())) label = `${label} (${i + 1})`;
    seen.add(label.toLowerCase());
    out.push({ ref: `col:${i}`, label, type: 'text' });
  });
  return out;
}

// What kind of file did the owner pick? Decides which import flow runs.
export function fileKind(file) {
  const name = String(file?.name || '').toLowerCase();
  const type = String(file?.type || '').toLowerCase();
  if (name.endsWith('.vcf') || name.endsWith('.vcard') || type.includes('vcard')) return 'vcf';
  if (name.endsWith('.ics') || name.endsWith('.ical') || type === 'text/calendar') return 'ics';
  if (name.endsWith('.xlsx') || name.endsWith('.xls') || name.endsWith('.numbers') || type.includes('spreadsheetml') || type.includes('ms-excel')) return 'excel';
  if (name.endsWith('.zip') || type.includes('zip')) return 'zip';
  if (name.endsWith('.csv') || name.endsWith('.tsv') || name.endsWith('.txt') || type.startsWith('text/')) return 'csv';
  return 'unknown';
}
