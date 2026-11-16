// A last-resort message for a save, send or delete that failed where the
// screen itself had no error handling. Without it the button just did
// nothing and the owner could not tell whether their change was kept.
//
// Only our own API failures (they carry a status and the request method),
// only for changes (never a background load), and never for "signed out"
// or "trial ended", which have their own screens. One at a time.
import { showNotice } from './confirm.js';

let last = 0;

export function describeUncaught(err) {
  if (!err || typeof err !== 'object') return null;
  const status = Number(err.status);
  if (!Number.isFinite(status) || typeof err.method !== 'string') return null;
  if (err.method === 'GET') return null;
  if (status === 401 || status === 402) return null;
  if (err.offline) return { title: "You're offline", body: 'That was not saved. Try again when you have signal.' };
  if (status === 0 || status >= 500) return { title: 'That did not go through', body: 'Something went wrong on our side. Please try again in a moment.' };
  const said = typeof err.message === 'string' && err.message.trim() && !/^HTTP \d+$/.test(err.message) ? err.message.trim() : 'Please check and try again.';
  return { title: 'That did not go through', body: said };
}

export function uncaughtNotice(err, now = Date.now()) {
  const notice = describeUncaught(err);
  if (!notice) return false;
  if (now - last < 4000) return false;
  last = now;
  showNotice(notice);
  return true;
}
