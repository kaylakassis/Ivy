// Contacts file (.vcf) reader, run in the browser so the owner's whole
// address book never leaves the device: only the people they tick as
// clients are sent to POST /api/clients/import.
//
// Handles vCard 2.1, 3.0 and 4.0 as exported by iPhone Contacts, iCloud.com,
// Google Contacts, Android and Outlook:
//   • folded lines (a line starting with a space or tab continues the last)
//   • vCard 2.1 quoted-printable values, including soft line breaks ("=" at
//     the end of a line) and a CHARSET parameter
//   • FN, or N (Family;Given;Middle;Prefix;Suffix) when FN is missing
//   • several EMAIL / TEL lines: the preferred one (TYPE=pref or PREF=1)
//     wins, then a mobile number, then the first
//   • item1.EMAIL style group prefixes, tel:/mailto: URIs, backslash escapes
// Defensive: input is capped at 5 MB and 5,000 contacts, every value is
// length-capped, PHOTO and other binary properties are skipped, and no
// regex here can backtrack badly. Pure function, no DOM.

export const VCARD_MAX_BYTES = 5 * 1024 * 1024;
export const VCARD_MAX_CONTACTS = 5000;
const MAX_LINE = 20000;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F]/g;

function clean(s, max) {
  return String(s || '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// Backslash escapes from vCard 3.0/4.0 text values.
function unescapeText(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) {
      const n = s[i + 1];
      out += (n === 'n' || n === 'N') ? ' ' : n;
      i++;
    } else out += c;
  }
  return out;
}

// Split on an unescaped separator (N is "Family;Given;...").
function splitUnescaped(s, sep) {
  const parts = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) { cur += c + s[i + 1]; i++; continue; }
    if (c === sep) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur);
  return parts;
}

function decodeQuotedPrintable(s, charset) {
  const bytes = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '=' && i + 2 < s.length + 1) {
      const hex = s.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) { bytes.push(parseInt(hex, 16)); i += 2; continue; }
      if (i === s.length - 1) continue; // stray soft break
    }
    const code = c.charCodeAt(0);
    if (code < 128) bytes.push(code);
    else {
      // Already-decoded non-ASCII: re-encode as UTF-8 bytes.
      const enc = typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(c) : [63];
      for (const b of enc) bytes.push(b);
    }
  }
  const arr = new Uint8Array(bytes);
  try {
    const label = String(charset || 'utf-8').toLowerCase();
    return new TextDecoder(label, { fatal: false }).decode(arr);
  } catch {
    try { return new TextDecoder('utf-8').decode(arr); } catch { return s; }
  }
}

// "item1.TEL;TYPE=CELL,pref;VALUE=uri" → { name: 'TEL', params: {...}, types: Set }
function parseProp(head) {
  const parts = splitParams(head);
  let name = (parts.shift() || '').toUpperCase();
  const dot = name.lastIndexOf('.');
  if (dot >= 0) name = name.slice(dot + 1);
  const params = {};
  const types = new Set();
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq < 0) {
      // vCard 2.1 bare parameter: TEL;CELL;PREF or ;QUOTED-PRINTABLE
      const bare = p.trim().toUpperCase();
      if (bare === 'QUOTED-PRINTABLE' || bare === 'BASE64' || bare === 'B') params.ENCODING = bare;
      else if (bare) types.add(bare.toLowerCase());
      continue;
    }
    const k = p.slice(0, eq).trim().toUpperCase();
    const v = p.slice(eq + 1).trim().replace(/^"|"$/g, '');
    if (k === 'TYPE') v.split(',').forEach((t) => t.trim() && types.add(t.trim().toLowerCase()));
    else if (k === 'PREF') types.add('pref');
    else params[k] = v;
  }
  return { name, params, types };
}

// Split the property head on ';' but not inside double quotes.
function splitParams(head) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < head.length; i++) {
    const c = head[i];
    if (c === '"') { q = !q; cur += c; continue; }
    if (c === ';' && !q) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

// Index of the ':' that ends the property head (skipping quoted params).
function headEnd(line) {
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') q = !q;
    else if (c === ':' && !q) return i;
  }
  return -1;
}

const EMAIL_OK = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

function pick(list) {
  if (!list.length) return '';
  const pref = list.find((x) => x.types.has('pref'));
  if (pref) return pref.value;
  const mobile = list.find((x) => x.types.has('cell') || x.types.has('mobile') || x.types.has('iphone'));
  if (mobile) return mobile.value;
  return list[0].value;
}

function finishCard(card) {
  let name = clean(card.fn, 120);
  if (!name && card.n) {
    const [family = '', given = '', middle = ''] = card.n;
    name = clean([given, middle, family].filter((x) => x && x.trim()).join(' '), 120);
  }
  if (!name && card.org) name = clean(card.org, 120);
  const email = pick(card.emails);
  const phone = pick(card.tels);
  return {
    name,
    email: email || '',
    phone: phone || '',
    org: clean(card.org, 120),
  };
}

// parseVCards(text) → { contacts: [{ name, email, phone, org }], skipped, truncated, error }
// skipped counts cards with nothing usable (no name, email or phone).
export function parseVCards(input) {
  const raw = String(input == null ? '' : input);
  if (raw.length > VCARD_MAX_BYTES) {
    return { contacts: [], skipped: 0, truncated: false, error: 'That contacts file is over 5 MB. Try exporting a smaller list.' };
  }
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const physical = text.split('\n');

  // Unfold: RFC 6350 folding (leading space/tab) for every version.
  const lines = [];
  for (const l of physical) {
    if ((l.startsWith(' ') || l.startsWith('\t')) && lines.length) {
      const prev = lines[lines.length - 1];
      if (prev.length < MAX_LINE) lines[lines.length - 1] = prev + l.slice(1);
    } else lines.push(l.length > MAX_LINE ? l.slice(0, MAX_LINE) : l);
  }

  const contacts = [];
  let skipped = 0;
  let truncated = false;
  let card = null;
  let depth = 0;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (!line.trim()) continue;
    const upper = line.trim().toUpperCase();
    if (upper === 'BEGIN:VCARD') {
      depth++;
      if (depth === 1) card = { fn: '', n: null, org: '', emails: [], tels: [] };
      continue;
    }
    if (upper === 'END:VCARD') {
      if (depth === 1 && card) {
        const c = finishCard(card);
        if (c.name) contacts.push(c);
        else skipped++;
        if (contacts.length >= VCARD_MAX_CONTACTS) { truncated = true; break; }
        card = null;
      }
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (!card || depth !== 1) continue;

    const colon = headEnd(line);
    if (colon <= 0) continue;
    const prop = parseProp(line.slice(0, colon));
    if (prop.name === 'PHOTO' || prop.name === 'LOGO' || prop.name === 'SOUND' || prop.name === 'KEY') continue;
    let value = line.slice(colon + 1);

    const qp = (prop.params.ENCODING || '').toUpperCase() === 'QUOTED-PRINTABLE';
    if (qp) {
      // vCard 2.1 soft line breaks: "=" at the end means the value goes on.
      let guard = 0;
      while (value.endsWith('=') && i + 1 < lines.length && guard < 200 && value.length < MAX_LINE) {
        value = value.slice(0, -1) + lines[++i];
        guard++;
      }
      value = decodeQuotedPrintable(value, prop.params.CHARSET);
    }

    switch (prop.name) {
      case 'FN':
        card.fn = unescapeText(value);
        break;
      case 'N':
        card.n = splitUnescaped(value, ';').map((p) => unescapeText(p).replace(/,/g, ' ').trim());
        break;
      case 'ORG':
        card.org = unescapeText(splitUnescaped(value, ';')[0] || '');
        break;
      case 'EMAIL': {
        const v = clean(unescapeText(value).replace(/^mailto:/i, ''), 254).toLowerCase();
        if (EMAIL_OK.test(v) && card.emails.length < 20) card.emails.push({ value: v, types: prop.types });
        break;
      }
      case 'TEL': {
        const v = clean(unescapeText(value).replace(/^tel:/i, ''), 40);
        if (/\d/.test(v) && card.tels.length < 20) card.tels.push({ value: v, types: prop.types });
        break;
      }
      default:
        break;
    }
  }

  return { contacts, skipped, truncated, error: null };
}
