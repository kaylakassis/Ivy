// The sign-up form's "are you a person" token (api/_lib/humanCheck.js).
// The server signs the time the page was opened; a sign-up that arrives
// under two seconds later was not typed by hand. primeFormToken() runs
// when the form appears; getFormToken() hands the token to the sign-up
// call, fetching one (and waiting out the two seconds) if the form never
// primed it, so no screen can forget.
import { api } from './api.js';

const MIN_AGE_MS = 2300;
let held = null;      // { token, at }
let inflight = null;

async function fetchToken() {
  try {
    const j = await api.get('/early-access/status');
    return typeof j?.formToken === 'string' && j.formToken ? { token: j.formToken, at: Date.now() } : null;
  } catch {
    return null;
  }
}

export function primeFormToken() {
  // A token older than 90 minutes is replaced (the server accepts two hours).
  if (held && Date.now() - held.at < 90 * 60 * 1000) return Promise.resolve(held);
  if (!inflight) inflight = fetchToken().then((t) => { held = t; inflight = null; return t; });
  return inflight;
}

export async function getFormToken() {
  const t = await primeFormToken();
  if (!t) return null;
  const wait = MIN_AGE_MS - (Date.now() - t.at);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  return t.token;
}

// A token is good for one account; the next sign-up on this page gets a new one.
export function clearFormToken() { held = null; }

// Name of the hidden field people never see (matches the server).
export const HONEYPOT_FIELD = 'ivy_contact_note';
