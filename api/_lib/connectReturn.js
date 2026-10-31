// Shared bits for the "Connect a payment processor" flows on the phone.
//
// On the web the Connect button is a plain link: the browser carries the
// session cookie to /api/finance/*-init, gets a 302 to the processor, and
// the processor sends the owner back to our callback with that same cookie.
//
// In the iOS app none of that holds: the app's pages are local files (a
// relative /api link 404s), auth is a Bearer token the browser can't
// forward, and the processor's return lands in Safari, which has no Ivy
// session. So the app asks the init endpoint for the URL as JSON
// (?mode=json&from=app), opens it in Safari, and we carry a short-lived
// signed `state` through the processor's return URL so the callback can
// finish the job without a session and hand the owner a "back to the app"
// page.
import jwt from 'jsonwebtoken';
import { appUrl } from './tokens.js';

// Square web flow: a random nonce lives in this HttpOnly cookie for the
// length of the OAuth round trip and its sha256 rides in the state JWT.
// The callback accepts the pair only together (see square-oauth-init.js).
export const SQ_STATE_COOKIE = 'sq_state';
export const SQ_STATE_TTL_SECONDS = 10 * 60;

export function wantsJson(req) {
  return req.query?.mode === 'json';
}
export function fromApp(req) {
  return req.query?.from === 'app';
}

// One hour is plenty for an onboarding form and short enough that a leaked
// link is useless the next day. The kind pins the token to one flow.
//
// `from` records which surface started the connect ('app' = the iOS shell
// opened Safari, 'web' = a browser tab with a session). Callbacks that mint
// state for BOTH surfaces (PayPal) read it to pick the landing page and to
// decide whether a session must also be present. Callers that only sign
// state for the phone flow (Stripe) can leave it out.
export function signReturnState({ workspaceId, userId, kind, from = 'app' }) {
  return jwt.sign({ wid: workspaceId, uid: userId, kind, from }, process.env.JWT_SECRET, { expiresIn: '1h', algorithm: 'HS256' });
}
export function verifyReturnState(token, kind) {
  if (!token || !process.env.JWT_SECRET) return null;
  try {
    const p = jwt.verify(String(token), process.env.JWT_SECRET, { algorithms: ['HS256'] });
    if (p.kind !== kind || !p.wid) return null;
    return { workspaceId: p.wid, userId: p.uid || null, from: p.from === 'web' ? 'web' : 'app' };
  } catch {
    return null;
  }
}

// Where the phone flow ends: a public page that says "done, go back to the
// app" (or what went wrong). Never /finance - Safari has no session there.
export function connectedPageUrl(provider, status, msg) {
  const u = new URL(`${appUrl()}/connected`);
  u.searchParams.set(provider, status);
  if (msg) u.searchParams.set('msg', String(msg).slice(0, 200));
  return u.toString();
}
