// Browser-side helpers for Web Push. Owns:
//   • Service-worker registration (idempotent)
//   • Subscription lifecycle: subscribe / unsubscribe / status
//   • Surfacing the right "permission denied" / "not supported" / "off"
//     messages so the settings UI can guide the user instead of
//     silently failing
import { api } from './api.js';
import { isNative } from './platform.js';
import {
  nativePermissionState, registerNativePush, unregisterNativePush,
  initNativePushOnLaunch, detachNativePush, pushTurnedOffHere, setPushTurnedOffHere,
} from './nativePush.js';

const SW_PATH = '/sw.js';

// Native permission is only knowable async; cache the last answer so
// the sync permissionState() contract the UI depends on keeps working.
// primeNativePermission() refreshes it (called by the consumers'
// effects via getSubscription()).
let nativePermCache = 'default';
async function primeNativePermission() {
  nativePermCache = await nativePermissionState();
  return nativePermCache;
}

export function pushSupported() {
  if (isNative()) return true; // APNs path - no service worker involved
  return typeof window !== 'undefined'
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window;
}

export function permissionState() {
  if (isNative()) return nativePermCache;
  if (!pushSupported()) return 'unsupported';
  return Notification.permission; // 'default' | 'granted' | 'denied'
}

async function getRegistration() {
  let reg = await navigator.serviceWorker.getRegistration(SW_PATH);
  if (!reg) reg = await navigator.serviceWorker.register(SW_PATH);
  return reg;
}

export async function getSubscription() {
  if (isNative()) {
    // "Subscribed" on native = OS permission granted (the launch init
    // re-registers the token whenever that's true) and not switched off
    // in Ivy on this device. Truthy sentinel keeps the settings toggle
    // rendering identically to web.
    const perm = await primeNativePermission();
    return perm === 'granted' && !pushTurnedOffHere() ? { native: true } : null;
  }
  if (!pushSupported()) return null;
  const reg = await getRegistration();
  return reg.pushManager.getSubscription();
}

// Convert the URL-safe base64 string the API returns into the Uint8Array
// that PushManager.subscribe wants for applicationServerKey.
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// Fetch VAPID public key, ask for browser permission (requires a user
// gesture caller-side), subscribe to PushManager, persist on the server.
// Returns the resulting subscription on success or throws on failure.
export async function subscribePush() {
  setPushTurnedOffHere(false);
  if (isNative()) {
    await registerNativePush();
    nativePermCache = 'granted';
    return { native: true };
  }
  if (!pushSupported()) throw new Error('Push not supported in this browser');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Notifications permission was not granted');

  const { publicKey } = await api.get('/push/vapid-public-key');
  if (!publicKey) throw new Error('Push notifications are not configured on this deployment');

  const reg = await getRegistration();
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
  }
  // Strip the keys from the subscription object - PushManager hands them
  // back as ArrayBuffers in the .toJSON() output, base64-encoded.
  const json = sub.toJSON();
  await api.post('/push/subscribe', {
    endpoint: json.endpoint,
    keys: json.keys,
    userAgent: navigator.userAgent,
  });
  return sub;
}

export async function unsubscribePush() {
  // Remember the choice on this device so the next app launch does not
  // quietly register again (native permission stays granted at OS level).
  setPushTurnedOffHere(true);
  if (isNative()) {
    await unregisterNativePush();
    return;
  }
  if (!pushSupported()) return;
  const reg = await getRegistration();
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  await api.post('/push/unsubscribe', { endpoint: sub.endpoint });
  await sub.unsubscribe();
}

// Every signed-in shell (owner, client portal, helper) calls this once on
// mount. It binds this device's push channel to whoever is signed in now,
// without ever prompting:
//   iPhone app: re-registers the APNs token when iOS permission is granted
//     (Apple rotates tokens; the server upserts and binds it to this user).
//   Browser: when permission is granted and a subscription exists, posts
//     it again so it belongs to the current account (a previous account
//     on this browser released it at sign-out).
// Skipped when the person switched notifications off in Ivy on this device.
export async function syncPushOnLaunch() {
  try {
    if (pushTurnedOffHere()) return;
    if (isNative()) { await initNativePushOnLaunch(); return; }
    if (!pushSupported() || Notification.permission !== 'granted') return;
    const reg = await navigator.serviceWorker.getRegistration(SW_PATH);
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    if (!sub) return;
    const json = sub.toJSON();
    if (!json?.endpoint || !json?.keys) return;
    await api.post('/push/subscribe', { endpoint: json.endpoint, keys: json.keys, userAgent: navigator.userAgent });
  } catch {
    /* best-effort: never block the shell */
  }
}

// Called on sign-out, BEFORE the session ends (the server needs to know
// whose row to drop). Releases this device from the account so the next
// person to sign in here never gets the previous account's notifications
// on their lock screen, and their own registration is not refused as
// "token in use". Leaves OS / browser permission alone. Capped at 3s so a
// slow network never holds up signing out.
export async function detachPushForSignOut() {
  const work = (async () => {
    try {
      if (isNative()) { await detachNativePush(); return; }
      if (!pushSupported()) return;
      const reg = await navigator.serviceWorker.getRegistration(SW_PATH);
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      if (sub) await api.post('/push/unsubscribe', { endpoint: sub.endpoint });
    } catch {
      /* best-effort */
    }
  })();
  await Promise.race([work, new Promise((r) => setTimeout(r, 3000))]);
}
