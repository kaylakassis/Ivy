// One answer to "may this request run a cron job?", shared by every
// api/cron/*.js handler. Three ways in, all fail closed:
//   • Authorization: Bearer <CRON_SECRET>   (Vercel cron)
//   • x-admin-secret: <ADMIN_SECRET>        (operator scripts)
//   • a signed-in super-admin session       (the in-app "run now" button)
// Secret compares are constant-time: both sides are hashed to 32 bytes
// first so timingSafeEqual never sees a length mismatch and the compare
// cannot leak the secret byte by byte. An unset secret never matches.
import { createHash, timingSafeEqual } from 'node:crypto';
import { isSuperAdminBySession } from './admin.js';

function secretsMatch(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || !provided || !expected) return false;
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function bearerToken(req) {
  const h = req?.headers || {};
  const auth = h.authorization || h.Authorization;
  if (typeof auth !== 'string' || !/^Bearer\s+/i.test(auth)) return '';
  return auth.replace(/^Bearer\s+/i, '').trim();
}

export async function cronAuthorized(req) {
  if (secretsMatch(bearerToken(req), process.env.CRON_SECRET)) return true;
  if (secretsMatch(req?.headers?.['x-admin-secret'], process.env.ADMIN_SECRET)) return true;
  try {
    return await isSuperAdminBySession(req);
  } catch {
    return false;
  }
}
