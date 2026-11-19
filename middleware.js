// Vercel edge middleware - runs in front of every /api/* request, the
// site root "/", and the Admin screen's code under /assets/op/.
//
// Three jobs (the third is at the bottom of this comment):
//
// 1. CORS for the Capacitor (native iOS/Android) shell on /api/*.
//
// The native WebView origin is `capacitor://localhost` on iOS (WebKit
// refuses to hand `https` to a custom scheme handler, so iosScheme=https
// is ignored) and `https://localhost` on Android. Our
// API lives at the production domain - so every native API call is
// cross-origin from the browser's POV and needs:
//
//   • Access-Control-Allow-Origin: <the exact native origin>
//     (wildcards are forbidden when credentials are involved)
//   • Access-Control-Allow-Credentials: true
//   • For preflight (OPTIONS): Allow-Methods / Allow-Headers covering
//     Authorization + X-Client-Platform + Idempotency-Key
//
// Web requests are same-origin, so this middleware is a no-op for them
// (no Origin header that matches Capacitor → no CORS headers added).
//
// Security: pairing with api/_lib/security.js requireSameOrigin -
// state-changing endpoints additionally check `X-Client-Platform`
// matches the Capacitor origin. So even if a hostile page somehow
// claimed `Origin: https://localhost`, it would still need to send the
// custom X-Client-Platform header (which triggers a real browser
// preflight, which only succeeds for Capacitor origins this middleware
// allows). Defense in depth.
//
// 2. The pre-rendered marketing home page at "/".
//
// scripts/prerender.mjs saves the public pages as static HTML under
// dist/prerender/ so crawlers that do not run JavaScript see the content.
// Every other public path is routed to its file by a vercel.json rewrite,
// but "/" cannot be: the filesystem match for dist/index.html wins before
// any rewrite runs. So the root is rewritten here, and only for a
// logged-out visitor on the Ivy marketing host:
//   • a connected custom domain serves that owner's site, never Ivy's
//     home page, so it is left alone;
//   • a signed-in visitor (session cookie present) gets the SPA shell as
//     before, which sends them straight on to their dashboard or portal
//     without first painting the marketing page.
// The native app loads index.html from the device and never hits "/".
//
// 3. The Admin screen's code, /assets/op/*.
//
// The build puts everything under src/features/admin/ into its own file
// in /assets/op/ (vite.config.js). Static files are served without any
// sign-in check, so that file used to be downloadable by anyone who read
// its name out of the main bundle. Here it is only handed to a browser
// holding a valid operator pass (api/_lib/operatorPass.js: a signed,
// short-lived cookie the app fetches for an operator just before loading
// the screen). Everyone else gets "not found". The pass grants nothing on
// the API; every admin request is still checked on the server.
import { next, rewrite } from '@vercel/edge';

export const config = {
  // API routes (CORS) and the site root (pre-rendered home). Other HTML /
  // asset routes use the static headers + rewrites in vercel.json.
  matcher: ['/api/:path*', '/', '/assets/op/:path*'],
};

const NATIVE_ORIGINS = new Set([
  'capacitor://localhost', // Capacitor iOS (the only scheme WebKit allows it)
  'https://localhost',     // Capacitor Android with androidScheme=https (ours)
  'http://localhost',      // Capacitor Android default
]);

const ALLOWED_HEADERS = [
  'Authorization',
  'Content-Type',
  'X-Client-Platform',
  'X-Helper-Workspace',
  'X-Requested-With',
  'Idempotency-Key',
].join(', ');

// Hosts the Ivy marketing site is served on (plus Vercel preview URLs so a
// deployment can be checked before DNS). Same set as isPlatformHost in
// src/lib/publicUrl.js minus localhost.
const MARKETING_HOSTS = new Set(['www.joinivy.ai', 'joinivy.ai']);
const SESSION_COOKIE = 'ivy_session'; // api/_lib/auth.js

function prerenderedHome(req) {
  const url = new URL(req.url);
  if (url.pathname !== '/') return null;
  if (req.method !== 'GET' && req.method !== 'HEAD') return null;
  const host = (req.headers.get('x-forwarded-host') || req.headers.get('host') || url.hostname)
    .toLowerCase().replace(/:\d+$/, '');
  if (!MARKETING_HOSTS.has(host) && !host.endsWith('.vercel.app')) return null;
  const cookie = req.headers.get('cookie') || '';
  if (new RegExp(`(^|;\\s*)${SESSION_COOKIE}=`).test(cookie)) return null;
  return rewrite(new URL('/prerender/index.html', url));
}

// ── Operator pass (job 3) ─────────────────────────────────────────────
// Same recipe as api/_lib/operatorPass.js, with the Web Crypto this
// runtime has: "<user id>.<expiry ms>.<hex HMAC-SHA256 of op|id|expiry>".
const OP_COOKIE = 'ivy_op';
const OP_PREFIX = '/assets/op/';
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function hasOperatorPass(req, nowMs = Date.now()) {
  const secret = process.env.JWT_SECRET;
  if (!secret) return false;
  const m = new RegExp(`(?:^|;\\s*)${OP_COOKIE}=([^;]+)`).exec(req.headers.get('cookie') || '');
  if (!m) return false;
  let raw;
  try { raw = decodeURIComponent(m[1]); } catch { return false; }
  const parts = raw.split('.');
  if (parts.length !== 3) return false;
  const [userId, exp, sig] = parts;
  if (!/^[0-9a-f-]{36}$/i.test(userId) || !/^\d{10,16}$/.test(exp) || !/^[0-9a-f]{64}$/.test(sig)) return false;
  if (Number(exp) <= nowMs) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const want = hex(await crypto.subtle.sign('HMAC', key, enc.encode(`op|${userId}|${exp}`)));
  // Fixed-length compare with no early exit.
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

export default async function middleware(req) {
  if (new URL(req.url).pathname.startsWith(OP_PREFIX)) {
    if (await hasOperatorPass(req)) {
      // Never stored by a shared cache: the next person through it may not
      // be an operator.
      return next({ headers: { 'Cache-Control': 'private, no-store' } });
    }
    return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
  }

  const home = prerenderedHome(req);
  if (home) return home;

  const origin = req.headers.get('origin') || '';
  const isNative = NATIVE_ORIGINS.has(origin);

  // Preflight: short-circuit with 204 + CORS headers so the actual
  // handler never sees the OPTIONS. (Most of our route files don't
  // implement OPTIONS and would 405 it.)
  if (req.method === 'OPTIONS' && isNative) {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': ALLOWED_HEADERS,
        // Cache the preflight result for 24h so we don't pay the
        // round-trip cost on every request.
        'Access-Control-Max-Age': '86400',
        'Vary': 'Origin',
      },
    });
  }

  if (!isNative) return next();

  // Forward to the API handler, then layer CORS response headers on top.
  const res = next();
  res.headers.set('Access-Control-Allow-Origin', origin);
  res.headers.set('Access-Control-Allow-Credentials', 'true');
  // Vary so caches don't poison a non-native response with native CORS.
  res.headers.append('Vary', 'Origin');
  return res;
}
