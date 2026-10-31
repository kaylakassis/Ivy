// One rule for every href that came from a user (site links, message
// attachments, client-supplied URLs): web links, mail/phone/SMS links,
// same-site paths and anchors render; anything else becomes '#'. The web
// CSP already blocks script URLs, but the native app renders the same
// bundle without that header, so the check lives in the markup too.
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
