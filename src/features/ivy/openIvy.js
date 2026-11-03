// Open Ivy from anywhere in the app with a prefilled message and, when
// `photo` is set, the photo menu already open so the owner can pick a
// screenshot in one tap.
//
// Web: the floating IvyDock (mounted in AppShell) listens for the
// 'ivy:open' event. iPhone app and anywhere the dock is not mounted: go to
// the full-page /ivy route, which reads ?prompt= and ?photo=1.
//
// Never sends anything: the owner reviews the message and presses send.
export const IVY_OPEN_EVENT = 'ivy:open';

export function openIvy({ prompt = '', photo = false, navigate } = {}) {
  const text = String(prompt || '').slice(0, 500);
  if (typeof window !== 'undefined' && window.__ivyDockMounted) {
    window.dispatchEvent(new CustomEvent(IVY_OPEN_EVENT, { detail: { prompt: text, photo: !!photo } }));
    return;
  }
  const q = new URLSearchParams();
  if (text) q.set('prompt', text);
  if (photo) q.set('photo', '1');
  const to = `/ivy${q.toString() ? `?${q}` : ''}`;
  if (navigate) navigate(to);
  else if (typeof window !== 'undefined') window.location.assign(to);
}
