// GET /api/finance/square-oauth-init
// Owner-only. Mints a signed state token that survives the OAuth round
// trip and redirects to Square's authorize page. The callback at
// /api/finance/square-oauth-callback verifies state and exchanges the
// returned code for an access token.
//
// This endpoint is reached via a top-level <a href> click, so we MUST
// redirect back to /finance with a query-string error code on failure
// - returning raw JSON would just appear as a blank-looking page in the
// browser (the "Square stuck loading" symptom). Mirrors the same error
// pattern as stripe-oauth-init.
import { requireUser, refuseImpersonated } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { requireSameOrigin } from '../_lib/security.js';
import { buildAuthorizeUrl, squareRedirectUri, squareEnv } from '../_lib/payments/square.js';
import { appUrl } from '../_lib/tokens.js';
import { methodNotAllowed, ok, badRequest } from '../_lib/json.js';
import { wantsJson, fromApp, SQ_STATE_COOKIE, SQ_STATE_TTL_SECONDS } from '../_lib/connectReturn.js';
import jwt from 'jsonwebtoken';
import cookie from 'cookie';
import crypto from 'node:crypto';

function back(res, msg) {
  const u = new URL(`${appUrl()}/finance`);
  u.searchParams.set('square', 'error');
  if (msg) u.searchParams.set('msg', String(msg).slice(0, 200));
  res.writeHead(302, { Location: u.toString() });
  res.end();
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!requireSameOrigin(req, res)) return;
  try {
    // Top-level navigation: if there's no session cookie, bounce to
    // /signin so the user lands somewhere useful instead of seeing
    // requireUser's raw 401 JSON.
    const asJson = wantsJson(req);
    if (!asJson && !req.headers.authorization
        && (!req.headers.cookie || !/(?:^|;\s*)ivy_session=/.test(req.headers.cookie))) {
      const dest = encodeURIComponent('/finance');
      res.writeHead(302, { Location: `/signin?next=${dest}` });
      res.end();
      return;
    }
    const user = await requireUser(req, res);
    if (!user) return;
    if (refuseImpersonated(req, res)) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;

    if (!process.env.SQUARE_APPLICATION_ID || !process.env.SQUARE_APPLICATION_SECRET) {
      if (asJson) return badRequest(res, 'Square is not set up on this deployment yet.');
      return back(res, 'Square is not configured on this deploy yet - admin needs to set SQUARE_APPLICATION_ID and SQUARE_APPLICATION_SECRET.');
    }
    if (!process.env.JWT_SECRET) {
      return back(res, 'Server misconfigured (JWT_SECRET missing).');
    }

    // Short-lived signed state - Square echoes this back; we verify it
    // in the callback so a man-in-the-middle can't swap tokens.
    //
    // Web flow: the state alone names a workspace but says nothing about
    // WHO completes Square's consent screen. A victim tricked into opening
    // an attacker's init URL would get a state for the attacker's
    // workspace, and the victim's Square merchant would end up bound to it
    // (or the reverse: the attacker completes consent against a state
    // minted for the victim). So we also drop a random nonce in an
    // HttpOnly cookie on this browser and put its hash in the state; the
    // callback only accepts the pair together, which ties the whole round
    // trip to the browser that clicked Connect.
    //
    // App flow (?from=app): the iOS shell opens Safari, which has none of
    // our cookies, so the state stays the only credential there. It is
    // the owner's own device and the state lives 15 minutes.
    const isApp = fromApp(req);
    let nonceHash = null;
    if (!isApp) {
      const nonce = crypto.randomBytes(32).toString('base64url');
      nonceHash = crypto.createHash('sha256').update(nonce).digest('hex');
      res.setHeader('Set-Cookie', cookie.serialize(SQ_STATE_COOKIE, nonce, {
        httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: SQ_STATE_TTL_SECONDS,
      }));
    }
    const state = jwt.sign(
      {
        wid: workspaceId, uid: user.id, kind: 'square_oauth',
        ...(isApp ? { from: 'app' } : { nonce: nonceHash }),
      },
      process.env.JWT_SECRET,
      { expiresIn: '15m', algorithm: 'HS256' },
    );
    const redirectUri = squareRedirectUri();
    const url = buildAuthorizeUrl({ state, redirectUri });
    // Diagnostic: the #1 Square-connect failure is a redirect_uri that
    // doesn't match the one registered in the Square dashboard (often
    // because APP_URL is unset and appUrl() falls back to the per-deploy
    // VERCEL_URL). Log the resolved values - never the signed state - so
    // a failed connect is debuggable from the Vercel logs.
    // eslint-disable-next-line no-console
    console.log('[square-oauth-init] env=%s redirect_uri=%s authorize_host=%s',
      squareEnv(), redirectUri, new URL(url).host);
    if (asJson) return ok(res, { url });
    res.writeHead(302, { Location: url });
    res.end();
  } catch (err) {
    console.error('[square-oauth-init] failed:', err);
    if (wantsJson(req)) return badRequest(res, err.message || 'Could not start Square connect');
    return back(res, err.message || 'Could not start Square connect');
  }
}
