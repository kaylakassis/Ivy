// Open Ivy from anywhere in the app with a prefilled message and, when
// `photo` is set, the photo menu already open so the owner can pick a
// screenshot in one tap.
//
// Web: the floating IvyDock (mounted in AppShell) listens for the
// 'ivy:open' event. iPhone app and anywhere the dock is not mounted: go to
// the full-page /ivy route, which reads ?prompt= and ?photo=1.
//
// By default nothing is sent: the owner reviews the message and presses
// send. `send: true` is for words the owner has just typed or tapped
// themselves inside the app (the "What do you want to do?" box on Home):
// those go to Ivy as their message straight away. It travels in memory
// (an event, or router state), never in a web address, so a link can still
// never put words in the owner's mouth.
export const IVY_OPEN_EVENT = 'ivy:open';

export function openIvy({ prompt = '', photo = false, send = false, navigate } = {}) {
  const text = String(prompt || '').slice(0, 500);
  if (typeof window !== 'undefined' && window.__ivyDockMounted) {
    window.dispatchEvent(new CustomEvent(IVY_OPEN_EVENT, { detail: { prompt: text, photo: !!photo, send: !!send && !!text } }));
    return;
  }
  if (send && text && navigate) { navigate('/ivy', { state: { ask: text } }); return; }
  const q = new URLSearchParams();
  if (text) q.set('prompt', text);
  if (photo) q.set('photo', '1');
  const to = `/ivy${q.toString() ? `?${q}` : ''}`;
  if (navigate) navigate(to);
  else if (typeof window !== 'undefined') window.location.assign(to);
}

// Fired after the owner approves an Ivy action (a tap on the approval
// card). Screens that show data Ivy may have just changed (the Website
// editor) listen and reload from the server. detail: { tools: string[] }.
export const IVY_ACTIONS_RAN_EVENT = 'ivy:actions-ran';

export function announceIvyActionsRan(tools = []) {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new CustomEvent(IVY_ACTIONS_RAN_EVENT, { detail: { tools: tools.filter(Boolean).map(String) } }));
  } catch { /* old browser: the editor still reloads on focus */ }
}
