// POST /api/auth/logout
import { clearSessionCookie } from '../_lib/auth.js';
import { methodNotAllowed, noContent } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  clearSessionCookie(res);
  return noContent(res);
}
