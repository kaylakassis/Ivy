// Launch mode for the public marketing site: 'open' (normal signups) or
// 'waitlist' (signups are invite-only; CTAs lead to the waitlist). One
// fetch per page load, shared by every CTA on the page. Falls back to
// 'open' on any error so a blip never hides the sign-up buttons.
import { useEffect, useState } from 'react';

let cached = null;
let inflight = null;
export function fetchLaunchMode() {
  if (cached) return Promise.resolve(cached);
  if (!inflight) {
    inflight = fetch('/api/early-access/status', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : {}))
      .then((j) => { cached = j && j.launchMode === 'waitlist' ? 'waitlist' : 'open'; return cached; })
      .catch(() => 'open');
  }
  return inflight;
}
export function useLaunchMode() {
  const [mode, setMode] = useState(cached || 'open');
  useEffect(() => { let live = true; fetchLaunchMode().then((m) => { if (live) setMode(m); }); return () => { live = false; }; }, []);
  return mode;
}
