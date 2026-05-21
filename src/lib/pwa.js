// PWA glue: service-worker registration + update detection, plus the
// "Add to home screen" install-prompt lifecycle. Framework-free so the
// beforeinstallprompt listener can be wired at first script eval (the
// event fires early). The React banner in components/PWAPrompts.jsx
// listens for the custom events dispatched here.
const SW_PATH = '/sw.js';

let deferredInstallPrompt = null;
let updateApplied = false;
let refreshing = false;

export function isStandalone() {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(display-mode: standalone)')?.matches
    || window.navigator.standalone === true;
}

// Capture the install prompt as early as possible (module-eval time).
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    window.dispatchEvent(new CustomEvent('pwa:install-available'));
  });
  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    window.dispatchEvent(new CustomEvent('pwa:installed'));
  });
}

export function canInstall() {
  return !!deferredInstallPrompt && !isStandalone();
}

// Show the native install dialog (must run from a user gesture).
// Returns 'accepted' | 'dismissed' | 'unavailable'.
export async function promptInstall() {
  const evt = deferredInstallPrompt;
  if (!evt) return 'unavailable';
  deferredInstallPrompt = null;
  evt.prompt();
  const { outcome } = await evt.userChoice.catch(() => ({ outcome: 'dismissed' }));
  return outcome;
}

export function registerServiceWorker() {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
  // Skip in dev so the cache doesn't fight Vite HMR.
  if (import.meta.env && import.meta.env.DEV) return;

  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register(SW_PATH);

      // A newer SW is already waiting (installed on a previous visit).
      if (reg.waiting && navigator.serviceWorker.controller) emitUpdate(reg);

      reg.addEventListener('updatefound', () => {
        const installing = reg.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
          // 'installed' + an existing controller ⇒ an update (not the
          // first install). Offer the user a reload.
          if (installing.state === 'installed' && navigator.serviceWorker.controller) {
            emitUpdate(reg);
          }
        });
      });
    } catch {
      // Best-effort: the app still works fully online without the SW.
    }
  });

  // Reload once the waiting SW takes over — but only when the user
  // applied an update, not on the first-install clients.claim().
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!updateApplied || refreshing) return;
    refreshing = true;
    window.location.reload();
  });
}

function emitUpdate(reg) {
  window.dispatchEvent(new CustomEvent('pwa:update-available', { detail: reg }));
}

// Tell the waiting SW to activate; controllerchange then reloads.
export async function applyUpdate(reg) {
  updateApplied = true;
  let r = reg;
  if (!r || !r.waiting) r = await navigator.serviceWorker.getRegistration();
  r?.waiting?.postMessage({ type: 'SKIP_WAITING' });
}
