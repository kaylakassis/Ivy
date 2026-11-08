// The one call that forgets everything the iPhone app kept for offline use:
// the snapshot (today's schedule, clients, recent messages) and any change
// still queued. Sign-out (src/lib/auth.jsx) and "Clear saved data on this
// phone" (Account) both use it. Never throws.
import { clearSnapshot } from './snapshot.js';
import { clearOfflineQueue } from './offlineQueue.js';

// keepWorkspace: the Account button (still signed in, so a fresh copy can
// start right away); sign-out leaves it off.
export async function clearOfflineData({ keepWorkspace = false } = {}) {
  await Promise.allSettled([clearSnapshot({ keepWorkspace }), clearOfflineQueue()]);
}
