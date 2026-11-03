// Client-list file helpers shared by the import hub: a forgiving CSV parser
// and column auto-detection tuned for the exports owners bring over from
// other booking apps (Square, Acuity, Vagaro, GlossGenius, Booksy,
// Calendly, Mindbody, Fresha), Google Contacts, and hand-made spreadsheets.
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

// Canonical fields a column can map to. 'firstName' / 'lastName' are joined
// into `name` when there is no full-name column. 'nameLastFirst' is a single
// column written "Doe, Jane" (some report exports do this).
export const CLIENT_FIELDS = ['name', 'firstName', 'lastName', 'nameLastFirst', 'email', 'phone', 'stage', 'notes', 'source', 'tags'];

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
    'client first name', 'customer first name', 'invitee first name', 'contact first name',
  ],
  lastName: [
    'last name', 'lastname', 'last', 'surname', 'family name', 'familyname', 'lname',
    'client last name', 'customer last name', 'invitee last name', 'contact last name',
  ],
  nameLastFirst: ['last name first name', 'last first', 'name last first'],
  email: [
    'email', 'e mail', 'email address', 'e mail address', 'emailaddress', 'mail',
    'client email', 'customer email', 'invitee email', 'contact email', 'primary email',
    'email 1', 'email1', 'e mail 1 value', 'email 1 value', 'personal email',
  ],
  phone: [
    'mobile', 'mobile phone', 'mobile number', 'mobile phone number', 'cell', 'cell phone',
    'cell number', 'cellphone', 'text message number', 'text reminder number', 'sms number',
    'phone', 'phone number', 'phonenumber', 'telephone', 'tel', 'primary phone',
    'client phone', 'customer phone', 'invitee phone', 'contact phone', 'phone 1',
    'phone 1 value', 'home phone', 'work phone', 'business phone', 'other phone',
  ],
  stage: ['stage', 'status', 'client status', 'customer status'],
  notes: [
    'notes', 'note', 'client notes', 'customer notes', 'client note', 'customer note',
    'memo', 'comments', 'comment', 'description', 'additional info', 'additional information',
    'staff notes', 'private notes', 'alert notes',
  ],
  source: ['source', 'lead source', 'how they found you', 'how did you hear about us', 'referral source', 'referral'],
  tags: ['tags', 'tag', 'labels', 'label', 'groups', 'group'],
};

const FIELD_ORDER = ['email', 'phone', 'nameLastFirst', 'firstName', 'lastName', 'name', 'notes', 'stage', 'source', 'tags'];

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
  if (!norm || NOT_A_VALUE.test(norm)) return '';
  const words = norm.split(' ');
  const has = (w) => words.includes(w);
  if (has('email') || has('e') && has('mail')) return 'email';
  if (has('mobile') || has('cell') || has('phone') || has('telephone')) return 'phone';
  if (has('first') && has('name')) return 'firstName';
  if ((has('last') || has('family')) && has('name')) return 'lastName';
  if (has('notes') || has('note')) return 'notes';
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
const VALID_STAGES = new Set(['lead', 'active', 'paused']);

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

// buildClientRows(records, mapping, { tags, stage }) → { rows, dropped }.
// rows are what POST /api/clients/import takes; `sourceIndex` remembers the
// record a row came from (for the error download). dropped counts rows with
// no name we could use.
export function buildClientRows(records, mapping, defaults = {}) {
  const defaultTags = Array.isArray(defaults.tags) ? defaults.tags : [];
  const defaultStage = VALID_STAGES.has(defaults.stage) ? defaults.stage : 'lead';
  const idx = {};
  (mapping || []).forEach((f, i) => { if (f && idx[f] === undefined) idx[f] = i; });
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
    const notes = cleanText(cell(cells, 'notes'), 4000);
    if (notes) row.notes = notes;
    const source = cleanText(cell(cells, 'source'), 60);
    if (source) row.source = source;
    const stage = cell(cells, 'stage').toLowerCase();
    row.stage = VALID_STAGES.has(stage) ? stage : defaultStage;
    const tagCell = cell(cells, 'tags');
    const tags = tagCell ? tagCell.split(/[,;|]/).map((t) => cleanText(t, 40)).filter(Boolean) : [];
    const allTags = Array.from(new Set([...tags, ...defaultTags])).slice(0, 20);
    if (allTags.length) row.tags = allTags;
    rows.push(row);
  });
  return { rows, dropped };
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
