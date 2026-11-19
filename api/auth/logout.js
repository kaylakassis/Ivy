// POST /api/auth/logout
import { clearSessionCookie } from '../_lib/auth.js';
import { clearOperatorPass } from '../_lib/operatorPass.js';
import { requireSameOrigin } from '../_lib/security.js';
import { methodNotAllowed, noContent } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  clearSessionCookie(res);
  clearOperatorPass(res);
  return noContent(res);
}
