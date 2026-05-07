// GET /api/finance/square-oauth-init
// Owner-only. Mints a signed state token that survives the OAuth round
// trip and redirects to Square's authorize page. The callback at
// /api/finance/square-oauth-callback verifies state and exchanges the
// returned code for an access token.
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { signSession } from '../_lib/auth.js';
import { requireSameOrigin } from '../_lib/security.js';
import { buildAuthorizeUrl, squareEnv } from '../_lib/payments/square.js';
import { appUrl } from '../_lib/tokens.js';
import { badRequest, methodNotAllowed, serverError } from '../_lib/json.js';
import jwt from 'jsonwebtoken';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);

    if (!process.env.SQUARE_APPLICATION_ID || !process.env.SQUARE_APPLICATION_SECRET) {
      return badRequest(res, 'Square is not configured on this deploy yet — set SQUARE_APPLICATION_ID + SQUARE_APPLICATION_SECRET.');
    }
    if (!process.env.JWT_SECRET) return badRequest(res, 'JWT_SECRET is not set');

    // Short-lived signed state — Square echoes this back; we verify it
    // in the callback so a man-in-the-middle can't swap tokens.
    const state = jwt.sign(
      { wid: workspaceId, uid: user.id, kind: 'square_oauth' },
      process.env.JWT_SECRET,
      { expiresIn: '15m' },
    );
    const redirectUri = `${appUrl()}/api/finance/square-oauth-callback`;
    const url = buildAuthorizeUrl({ state, redirectUri });
    res.writeHead(302, { Location: url });
    res.end();
  } catch (err) {
    return serverError(res, err);
  }
}
