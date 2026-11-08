// The one call that forgets everything the iPhone app kept for offline use:
// the snapshot (today's schedule, clients, recent messages) and any change
// still queued. Sign-out (src/lib/auth.jsx) and "Clear saved data on this
// phone" (Account) both use it. Never throws.
import { clearSnapshot } from './snapshot.js';
import { clearOfflineQueue } from './offlineQueue.js';

export async function clearOfflineData() {
  await Promise.allSettled([clearSnapshot(), clearOfflineQueue()]);
}
