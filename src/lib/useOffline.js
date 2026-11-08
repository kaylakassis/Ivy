// React hooks over src/lib/offline.js and src/lib/snapshot.js.
//
//   useOffline()           true while the phone or computer has no signal
//   useSnapshot(section)   { items, savedAt } saved on this phone, or null
//                          (native only; re-renders when the copy changes)
//   useSnapshotBar(at)     tells the offline bar this screen is showing the
//                          saved copy from `at` (the bar then reads
//                          "Offline. Showing what Ivy saved at 9:41 AM.")
import { useEffect, useState } from 'react';
import { isOffline, subscribeOffline } from './offline.js';
import { readSnapshot, subscribeSnapshot, primeSnapshot, isSnapshotPrimed } from './snapshot.js';
import { isNative } from './platform.js';

export function useOffline() {
  const [off, setOff] = useState(isOffline);
  useEffect(() => subscribeOffline(setOff), []);
  return off;
}

export function useSnapshot(section) {
  const native = isNative();
  const [, tick] = useState(0);
  useEffect(() => {
    if (!native) return undefined;
    if (!isSnapshotPrimed()) primeSnapshot();
    return subscribeSnapshot(() => tick((n) => n + 1));
  }, [native]);
  return native ? readSnapshot(section) : null;
}

// Registry of screens currently rendering from the saved copy.
const bars = new Map();
const barListeners = new Set();
let barSeq = 0;
function emitBars() { for (const fn of barListeners) fn(); }

export function useSnapshotBar(savedAt, active = true) {
  useEffect(() => {
    if (!active || !savedAt) return undefined;
    const id = ++barSeq;
    bars.set(id, savedAt);
    emitBars();
    return () => { bars.delete(id); emitBars(); };
  }, [savedAt, active]);
}

// The newest savedAt among registered screens, or null.
export function currentSnapshotBar() {
  let best = null;
  for (const at of bars.values()) if (!best || at > best) best = at;
  return best;
}

export function useCurrentSnapshotBar() {
  const [at, setAt] = useState(currentSnapshotBar);
  useEffect(() => {
    const fn = () => setAt(currentSnapshotBar());
    barListeners.add(fn);
    return () => barListeners.delete(fn);
  }, []);
  return at;
}
