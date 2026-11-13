// Website copy is plain text. Formatting marks that sneak in (pasted from a
// document, or written by an assistant: "**bold**", "<br>", "[text](link)")
// would otherwise show up on the owner's site as raw symbols, which reads
// as code. These helpers turn such marks into the plain words they stand
// for. Pure functions, shared by the site renderer, the editor and the
// server (website save + Ivy's website tools).
//
// Deliberately conservative: only unmistakable markup is touched. A lone
// asterisk ("*terms apply"), a dash list, "3 < 5" or "#1 rated" stay as
// typed.

const ENTITIES = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'" };
const MAYBE_MARKUP = /[<`]|\*\*|__|\]\(|^\s{0,3}#{1,6}\s|&(?:nbsp|amp|lt|gt|quot|apos|#39);/m;

export function cleanSiteCopy(value) {
  if (typeof value !== 'string' || value.length < 3 || !MAYBE_MARKUP.test(value)) return value;
  let s = value;
  // HTML: drop script/style blocks whole, turn block ends into line breaks,
  // list items into bullets, then remove any remaining tags.
  s = s.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<li\b[^>]*>/gi, '• ');
  s = s.replace(/<\/(p|div|li|h[1-6]|tr|ul|ol|blockquote|section)\s*>/gi, '\n');
  s = s.replace(/<\/?[a-zA-Z][a-zA-Z0-9-]*(\s[^<>]*)?\/?>/g, '');
  s = s.replace(/&(?:nbsp|amp|lt|gt|quot|apos|#39);/g, (m) => ENTITIES[m] || m);
  // Markdown: links keep their words, bold / code marks go, headings lose
  // their leading #s.
  s = s.replace(/!?\[([^\]\n]+)\]\((?:https?:\/\/|mailto:|tel:|\/|#)[^)\s]*\)/g, '$1');
  s = s.replace(/\*\*\*?(\S(?:[^*\n]*?\S)?)\*\*\*?/g, '$1');
  s = s.replace(/(^|[^\w])__(\S(?:[^_\n]*?\S)?)__(?=[^\w]|$)/g, '$1$2');
  s = s.replace(/`{1,3}([^`\n]+)`{1,3}/g, '$1');
  s = s.replace(/^[ \t]{0,3}#{1,6}[ \t]+(?=\S)/gm, '');
  if (s === value) return value;
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Keys whose values are addresses, ids or settings, never copy.
const SKIP_KEY = /(^id$|url$|href$|link$|src$|^image$|^images$|^photos$|img|^platform$|^variant$|^icon$|^slug$|^handle$|^type$|^layout$|^color$|^date$|^time$|^endsAt$|^target$|^lat$|^lng$|^embed)/i;
// Code sections (kept only for sites that already had one) hold code on
// purpose; they are never rewritten.
const CODE_TYPES = new Set(['code_snippet', 'custom_html']);

function cleanNode(node, depth) {
  if (depth > 12 || node == null) return node;
  if (typeof node === 'string') return cleanSiteCopy(node);
  if (Array.isArray(node)) {
    let changed = false;
    const out = node.map((x) => { const y = cleanNode(x, depth + 1); if (y !== x) changed = true; return y; });
    return changed ? out : node;
  }
  if (typeof node !== 'object') return node;
  let out = null;
  for (const [k, v] of Object.entries(node)) {
    if (SKIP_KEY.test(k)) continue;
    const y = cleanNode(v, depth + 1);
    if (y !== v) { if (!out) out = { ...node }; out[k] = y; }
  }
  return out || node;
}

// A section's data with clean copy. Returns the SAME object when nothing
// needed cleaning, so callers can use it in render without churn.
export function cleanSectionData(type, data) {
  if (CODE_TYPES.has(type) || data == null || typeof data !== 'object') return data;
  return cleanNode(data, 0);
}

export function cleanSectionCopy(section) {
  if (!section || typeof section !== 'object') return section;
  const data = cleanSectionData(section.type, section.data);
  return data === section.data ? section : { ...section, data };
}

export function cleanPagesCopy(pages) {
  if (!Array.isArray(pages)) return pages;
  return pages.map((p) => (p && Array.isArray(p.sections)
    ? { ...p, sections: p.sections.map(cleanSectionCopy) }
    : p));
}
