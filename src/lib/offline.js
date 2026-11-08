// Are we offline? Two signals, either one is enough:
//   • the browser says so (navigator.onLine === false, the online/offline
//     events), which iOS reports reliably in airplane mode but not always
//     in a basement with one flickering bar;
//   • a request never got an answer (status 0 / TypeError from fetch, not
//     a timeout we chose), reported by src/lib/api.js.
// Any answered request (even an error) puts us back online. While offline
// with no requests going out, the shell probes /api/health every few
// seconds (see src/lib/useOffline.js) so the bar drops as soon as signal
// returns.
//
// Pure module: no React, no window access beyond what is handed in, so
// tests run it in Node.
export const OFFLINE_MESSAGE = "You're offline. Try again when you have signal.";

let browserOnline = true;
let failedRequest = false;
let offline = false;
const listeners = new Set();
const requestListeners = new Set();
let lastRequestToast = 0;

function recompute() {
  const next = !browserOnline || failedRequest;
  if (next === offline) return;
  offline = next;
  for (const fn of listeners) { try { fn(offline); } catch { /* listener error */ } }
}

export function isOffline() { return offline; }

// navigator.onLine and its events.
export function setBrowserOnline(on) {
  browserOnline = on !== false;
  // Coming back online by the browser's word: trust it until the next
  // failed request says otherwise.
  if (browserOnline) failedRequest = false;
  recompute();
}

// A fetch that threw (status 0). Aborts are our own timeouts, not signal.
export function noteNetworkFailure(err) {
  if (!err || err.status !== 0 || err.aborted || err.name === 'AbortError') return false;
  if (err.cause === 'aborted') return false;
  failedRequest = true;
  recompute();
  return true;
}

// Any response from the server, success or not.
export function noteNetworkSuccess() {
  if (!failedRequest && browserOnline) return;
  failedRequest = false;
  recompute();
}

// fn(offline: boolean) on every change.
export function subscribeOffline(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// A request failed for lack of signal: the web shows a short toast for
// this (src/components/OfflineBanner.jsx). Throttled so a screen that
// fires five requests at once gets one toast.
export function noteOfflineRequest(now = Date.now()) {
  if (lastRequestToast && now - lastRequestToast < 6000) return false;
  lastRequestToast = now;
  for (const fn of requestListeners) { try { fn(); } catch { /* listener error */ } }
  return true;
}

export function subscribeOfflineRequests(fn) {
  requestListeners.add(fn);
  return () => requestListeners.delete(fn);
}

// Wire the browser events once (app shell). Returns the unsubscribe.
export function attachBrowserEvents(win = typeof window !== 'undefined' ? window : null) {
  if (!win || !win.addEventListener) return () => {};
  setBrowserOnline(win.navigator?.onLine !== false);
  const on = () => setBrowserOnline(true);
  const off = () => setBrowserOnline(false);
  win.addEventListener('online', on);
  win.addEventListener('offline', off);
  return () => { win.removeEventListener('online', on); win.removeEventListener('offline', off); };
}

// Tests only.
export function resetOfflineForTests() {
  browserOnline = true; failedRequest = false; offline = false; lastRequestToast = 0;
  listeners.clear(); requestListeners.clear();
}
