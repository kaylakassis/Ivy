// One allowlist for the HTML body of a written document (contracts,
// waivers, intake forms). Used everywhere that body is saved or shown:
// the owner's editor (RichTextEditor) and preview, the signing page, the
// document API on save and on load (api/documents/*, api/_lib/documents.js)
// and the signed PDF (api/_lib/pdfStamp.js). Pure string code, no DOM, so
// the server and the browser run the same rules.
//
// Kept: what the editor produces and the built-in templates use
//   h1 h2 h3 p br strong em u ul ol li, and a links to http(s) or mailto.
//   <b>/<i> become <strong>/<em> and <div> becomes <p>, the same rewrite the
//   editor already does on save, so a body reads the same everywhere.
// Removed: every attribute (except a checked href), every other tag (its
//   text stays), and script/style/iframe-like elements with their contents.
// Text is kept as written; a stray "<" or "&" is escaped so it can never
// start a tag. Signature and other fields are not in the HTML (they live in
// documents.fields), so there are no placeholders to keep.
//
// Running it twice gives the same result as running it once.

const KEEP = new Set(['h1', 'h2', 'h3', 'p', 'br', 'strong', 'em', 'u', 'ul', 'ol', 'li', 'a']);
const RENAME = { b: 'strong', i: 'em', div: 'p' };
const VOID = new Set(['br']);
// Elements whose contents are never document text.
const DROP_WITH_CONTENT = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'noscript', 'noembed', 'noframes',
  'template', 'textarea', 'title', 'xmp', 'svg', 'math', 'select', 'head',
]);
export const DOC_HTML_MAX = 200000;

const ENTITY_RE = /^&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});/i;

function escapeText(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '<') out += '&lt;';
    else if (c === '&') out += ENTITY_RE.test(s.slice(i, i + 40)) ? '&' : '&amp;';
    else out += c;
  }
  return out;
}

// Attribute values may use character references; decode the ones a scheme
// could hide behind (numeric ones, &colon;, &Tab;, &NewLine; ...) before the
// scheme is checked. "&b=2" in a query string (no ";") stays as written.
const NAMED_REFS = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', colon: ':', tab: '\t', newline: '\n', sol: '/', period: '.', nbsp: ' ' };
function decodeAttr(v) {
  let bad = false;
  const out = v
    .replace(/&#(x[0-9a-f]+|\d+);?/gi, (m, e) => {
      const n = e[0] === 'x' || e[0] === 'X' ? parseInt(e.slice(1), 16) : Number(e);
      if (!Number.isInteger(n) || n < 1 || n > 0x10ffff) { bad = true; return ''; }
      return String.fromCodePoint(n);
    })
    .replace(/&([a-z]+);/gi, (m, e) => {
      const k = e.toLowerCase();
      return k in NAMED_REFS ? NAMED_REFS[k] : m;
    });
  return bad ? null : out;
}

export function safeDocHref(raw) {
  if (raw == null) return null;
  const v = decodeAttr(String(raw));
  if (v == null) return null;
  const s = v.trim();
  // Browsers drop tabs and newlines inside a URL, which can hide a scheme.
  if (!s || s.length > 2000 || /[\u0000- \u007f-\u009f]/.test(s)) return null;
  if (!/^(https?:\/\/[^/?#]+|mailto:[^/?#\s]+@)/i.test(s)) return null;
  return s;
}

const escAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Reads the attributes of one tag (between the name and the closing ">"),
// honouring quotes the way a browser does. Returns { attrs, end } where
// end is the index just past ">" or -1 when the tag never closes.
function readTag(html, i) {
  const attrs = {};
  const n = html.length;
  while (i < n) {
    while (i < n && /[\s/]/.test(html[i])) i++;
    if (i >= n) return { attrs, end: -1 };
    if (html[i] === '>') return { attrs, end: i + 1 };
    let name = '';
    while (i < n && !/[\s/>=]/.test(html[i])) name += html[i++];
    while (i < n && /\s/.test(html[i])) i++;
    let value = '';
    if (html[i] === '=') {
      i++;
      while (i < n && /\s/.test(html[i])) i++;
      const q = html[i];
      if (q === '"' || q === "'") {
        const close = html.indexOf(q, i + 1);
        if (close === -1) return { attrs, end: -1 };
        value = html.slice(i + 1, close);
        i = close + 1;
      } else {
        while (i < n && !/[\s>]/.test(html[i])) value += html[i++];
      }
    }
    const key = name.toLowerCase();
    if (key && !(key in attrs)) attrs[key] = value;
  }
  return { attrs, end: -1 };
}

export function sanitizeDocHtml(input) {
  if (input == null) return '';
  const html = String(input).slice(0, DOC_HTML_MAX);
  let out = '';
  let text = '';
  const flush = () => { if (text) { out += escapeText(text); text = ''; } };
  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) { text += html.slice(i); break; }
    text += html.slice(i, lt);
    i = lt;
    const next = html[i + 1] || '';
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (next === '!' || next === '?') {
      const end = html.indexOf('>', i);
      i = end === -1 ? n : end + 1;
      continue;
    }
    const closing = next === '/';
    const start = i + (closing ? 2 : 1);
    const m = /^[a-z][a-z0-9-]*/i.exec(html.slice(start, start + 64));
    if (!m) {
      if (closing) {
        // "</" not followed by a name is a bogus comment in a browser.
        const end = html.indexOf('>', i);
        i = end === -1 ? n : end + 1;
      } else {
        text += '<';
        i += 1;
      }
      continue;
    }
    const raw = m[0].toLowerCase();
    const { attrs, end } = readTag(html, start + m[0].length);
    if (end === -1) { i = n; break; } // a tag cut off at the end is dropped
    i = end;
    if (!closing && DROP_WITH_CONTENT.has(raw)) {
      const re = new RegExp(`</${raw}\\b[^>]*>`, 'ig');
      re.lastIndex = i;
      const close = re.exec(html);
      i = close ? re.lastIndex : n;
      continue;
    }
    const tag = RENAME[raw] || raw;
    if (!KEEP.has(tag)) continue;
    flush();
    if (closing) {
      if (!VOID.has(tag)) out += `</${tag}>`;
      continue;
    }
    if (tag === 'a') {
      const href = safeDocHref(attrs.href);
      out += href ? `<a href="${escAttr(href)}" target="_blank" rel="noopener noreferrer">` : '<a>';
      continue;
    }
    out += `<${tag}>`;
  }
  flush();
  return out;
}
