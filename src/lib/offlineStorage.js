// Where the iPhone app keeps its small offline copy (src/lib/snapshot.js)
// and the actions queued while offline (src/lib/offlineQueue.js).
//
// Native only: the store is @capacitor/preferences inside the app's own
// sandbox. On the web there is no store at all - a shared browser is not
// one person's phone - so every read answers null and every write is a
// no-op. Tests swap in a memory store with setOfflineStorageForTests().
import { isNative } from './platform.js';

let override = null;
let prefsPromise = null;

// Returns the MODULE for @capacitor/preferences (never the proxy itself -
// see nativeAuth.js for why awaiting the proxy hangs).
function prefsModule() {
  if (!prefsPromise) prefsPromise = import('@capacitor/preferences');
  return prefsPromise;
}

export function setOfflineStorageForTests(store) { override = store || null; }

export function memoryOfflineStorage() {
  const m = new Map();
  return {
    async get(key) { return m.has(key) ? m.get(key) : null; },
    async set(key, value) { m.set(key, String(value)); },
    async remove(key) { m.delete(key); },
    _map: m,
  };
}

// { get, set, remove } with string values, or null when there is no store.
export function getOfflineStorage() {
  if (override) return override;
  if (!isNative()) return null;
  return {
    async get(key) {
      const { Preferences } = await prefsModule();
      const { value } = await Preferences.get({ key });
      return value ?? null;
    },
    async set(key, value) {
      const { Preferences } = await prefsModule();
      await Preferences.set({ key, value: String(value) });
    },
    async remove(key) {
      const { Preferences } = await prefsModule();
      await Preferences.remove({ key });
    },
  };
}

export function hasOfflineStorage() { return !!getOfflineStorage(); }
