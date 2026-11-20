// Confirm-first sign-up: the ticket.
//
// A sign-up no longer tells the person at the keyboard whether the email
// they typed already has an Ivy account (that let anyone test which
// addresses use Ivy). Whatever was typed, the answer is "check your email",
// and the truth goes to the inbox: a link to finish, or a note that the
// address already has an account.
//
// The ticket is what the sign-up answer carries so the same browser or app
// can pick the thread back up: see whether the link has been opened yet
// (api/auth/signup-status.js) and be signed straight in when it is
// (api/auth/verify-email.js). It is "<account id>.<expiry>.<signature>".
// When the address already had an account the ticket is for an id that
// belongs to nobody, signed the same way, so the two cases cannot be told
// apart by looking at it or by asking about it.
import crypto from 'node:crypto';

export const TICKET_TTL_MS = 24 * 60 * 60 * 1000;

function sign(userId, exp) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('Signing secret is not set');
  return crypto.createHmac('sha256', secret).update(`signup|${userId}|${exp}`).digest('hex');
}

export function makeSignupTicket(userId, nowMs = Date.now()) {
  const exp = nowMs + TICKET_TTL_MS;
  return `${userId}.${exp}.${sign(userId, exp)}`;
}
// A ticket for nobody (the "this address already has an account" case).
export const makeDecoyTicket = () => makeSignupTicket(crypto.randomUUID());

// The account id a ticket is for, or null when it is not a valid ticket.
export function readSignupTicket(ticket, nowMs = Date.now()) {
  const parts = String(ticket || '').split('.');
  if (parts.length !== 3) return null;
  const [userId, exp, sig] = parts;
  if (!/^[0-9a-f-]{36}$/i.test(userId) || !/^\d{10,16}$/.test(exp) || !/^[0-9a-f]{64}$/.test(sig)) return null;
  if (Number(exp) <= nowMs) return null;
  let want;
  try { want = sign(userId, exp); } catch { return null; }
  const a = Buffer.from(want, 'hex'); const b = Buffer.from(sig, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return userId;
}
