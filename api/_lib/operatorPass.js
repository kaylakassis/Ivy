// The operator pass: a short-lived signed cookie that lets a signed-in
// operator's browser download the Admin screen's code.
//
// The Admin screen is its own code file, served from /assets/op/. Every
// request the screen makes is already checked on the server, so nobody who
// is not an operator can DO anything with it. But the file itself lists
// what the operator tools are and how they are called, and that is not for
// strangers to read. middleware.js refuses /assets/op/* without a valid
// pass; api/auth/operator-pass.js hands one to an operator just before the
// screen loads.
//
// The pass says nothing by itself and grants nothing on the API: it is
// "<user id>.<expiry>.<signature>", scoped to the /assets/op path, and the
// signature is an HMAC with the server's own secret. middleware.js checks
// it with the same recipe (kept in step by tests/operator-pass.test.mjs).
import crypto from 'node:crypto';
import cookie from 'cookie';

export const OP_COOKIE = 'ivy_op';
export const OP_PATH = '/assets/op';
export const OP_TTL_SECONDS = 12 * 60 * 60;

export function operatorPassValue(userId, nowMs = Date.now()) {
  const secret = process.env.JWT_SECRET;
  if (!secret || !userId) return null;
  const exp = nowMs + OP_TTL_SECONDS * 1000;
  const sig = crypto.createHmac('sha256', secret).update(`op|${userId}|${exp}`).digest('hex');
  return `${userId}.${exp}.${sig}`;
}

function appendCookie(res, value) {
  const prev = res.getHeader?.('Set-Cookie');
  const list = prev ? (Array.isArray(prev) ? prev : [prev]) : [];
  res.setHeader('Set-Cookie', [...list, value]);
}

export function setOperatorPass(res, userId) {
  const value = operatorPassValue(userId);
  if (!value) return false;
  appendCookie(res, cookie.serialize(OP_COOKIE, value, {
    httpOnly: true, secure: true, sameSite: 'lax', path: OP_PATH, maxAge: OP_TTL_SECONDS,
  }));
  return true;
}

export function clearOperatorPass(res) {
  appendCookie(res, cookie.serialize(OP_COOKIE, '', { httpOnly: true, secure: true, sameSite: 'lax', path: OP_PATH, maxAge: 0 }));
}
