// Tells the server which screen the owner just opened, so the operator can
// see where new accounts stop (Admin > First week). A screen name from a
// fixed list and nothing else: no client data, nothing typed, nothing about
// what is on the screen. At most once a minute per screen, and a failure is
// ignored.
import { api } from './api.js';
import { screenFor } from './screenNames.js';

export { screenFor };

const lastSent = new Map();
export function trackScreen(pathname, search) {
  const screen = screenFor(pathname, search);
  if (!screen) return;
  const now = Date.now();
  if (now - (lastSent.get(screen) || 0) < 60000) return;
  lastSent.set(screen, now);
  api.post('/me/screen', { screen }).catch(() => { /* never matters */ });
}
