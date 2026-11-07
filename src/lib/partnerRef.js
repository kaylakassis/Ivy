// Links in an accountability-partner message (push, bell, email) carry
// ?ptr=<channel>.<message id> so the admin view can count "opened from the
// message". When the app opens on such a link we tell the server once and
// take the parameter out of the address bar. Counts only; never blocks.
import { api } from './api.js';

const REF_RE = /^[ne]\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const seen = new Set();

export function partnerRefFrom(search) {
  try {
    const ref = new URLSearchParams(search || '').get('ptr');
    return ref && REF_RE.test(ref) ? ref : null;
  } catch { return null; }
}

export function consumePartnerRef(search) {
  const ref = partnerRefFrom(search);
  if (!ref) return;
  try {
    const u = new URL(window.location.href);
    u.searchParams.delete('ptr');
    window.history.replaceState(window.history.state, '', `${u.pathname}${u.search}${u.hash}`);
  } catch { /* leave the address as it is */ }
  if (seen.has(ref)) return;
  seen.add(ref);
  api.post('/me/accountability', { action: 'opened', ref }).catch(() => {});
}
