// Link safety for owner-authored site content.
//
// Site sections, pages and the sticky bar are stored as JSON the owner
// shapes freely. Every link-like value in that JSON is rendered as an
// <a href> for visitors, on our origin and inside the native app, so a
// value such as `javascript:...` must never be stored. We keep only web
// links (http/https), mail/phone/SMS links, same-site paths and anchors.
const LINK_KEYS = new Set([
  'url', 'href', 'link', 'ctaLink', 'ctaHref', 'ctaUrl', 'buttonLink', 'buttonUrl',
  'videoUrl', 'linkUrl', 'secondaryLink', 'secondaryCtaLink', 'mapUrl', 'embedUrl',
]);

export function isSafeHref(value) {
  if (value == null) return true;
  const s = String(value).trim();
  if (s === '') return true;
  if (s.startsWith('#') || s.startsWith('/')) return !s.startsWith('//');
  return /^(https?:|mailto:|tel:|sms:)/i.test(s);
}

export function safeHref(value, fallback = '#') {
  return isSafeHref(value) ? value : fallback;
}

// Deep-walks arrays and plain objects; any link-like key with an unsafe
// value becomes '#'. Everything else is returned untouched.
export function sanitizeSiteLinks(node, depth = 0) {
  if (depth > 20 || node == null) return node;
  if (Array.isArray(node)) return node.map((x) => sanitizeSiteLinks(x, depth + 1));
  if (typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (LINK_KEYS.has(k) && typeof v === 'string') out[k] = safeHref(v);
    else out[k] = sanitizeSiteLinks(v, depth + 1);
  }
  return out;
}

// Only https links are stored for anything a person pastes (program event
// links, a virtual service's meeting link). Returns the normalised link,
// null for blank, or undefined for anything else (http:, javascript:,
// data:, a link with a login in it, text that is not a link).
export function cleanHttpsUrl(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' || u.username || u.password) return undefined;
    return u.toString().slice(0, 1000);
  } catch { return undefined; }
}
