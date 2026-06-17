// Native-side auth token storage.
//
// On the web the session lives in an HttpOnly cookie (set by /api/auth/login
// etc.) and the browser sends it automatically. On native (Capacitor),
// the WebView origin is `https://localhost` while the API lives at our
// production domain — cross-origin XHR drops the SameSite=Lax cookie,
// so we instead store the raw JWT in iOS Keychain via @capacitor/preferences
// and attach it as `Authorization: Bearer <token>` on every request.
//
// The token is returned by login/signup endpoints when the X-Client-Platform
// header is set (so web responses keep the cookie-only shape).
//
// All exports are async because @capacitor/preferences is dynamically
// imported — keeps the web bundle from pulling the Capacitor SDK.
import { isNative } from './platform.js';

const KEY = 'ivy_session_token';

let memoryToken = null;
let primed = false;
let primePromise = null;

async function prefs() {
  if (!isNative()) return null;
  const mod = await import('@capacitor/preferences');
  return mod.Preferences;
}

// Load the token once on app boot so subsequent reads are sync from
// memory. Safe to call repeatedly — returns the same in-flight promise.
export function primeNativeAuth() {
  if (primed) return Promise.resolve(memoryToken);
  if (primePromise) return primePromise;
  primePromise = (async () => {
    try {
      const p = await prefs();
      if (!p) { primed = true; return null; }
      const { value } = await p.get({ key: KEY });
      memoryToken = value || null;
    } catch {
      memoryToken = null;
    } finally {
      primed = true;
    }
    return memoryToken;
  })();
  return primePromise;
}

export function getNativeAuthToken() {
  return memoryToken;
}

export async function setNativeAuthToken(token) {
  memoryToken = token || null;
  const p = await prefs();
  if (!p) return;
  if (token) await p.set({ key: KEY, value: token });
  else      await p.remove({ key: KEY });
}

export async function clearNativeAuthToken() {
  return setNativeAuthToken(null);
}
