// Vercel edge middleware - runs in front of every /api/* request and the
// site root "/".
//
// Two jobs:
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
import { next, rewrite } from '@vercel/edge';

export const config = {
  // API routes (CORS) and the site root (pre-rendered home). Other HTML /
  // asset routes use the static headers + rewrites in vercel.json.
  matcher: ['/api/:path*', '/'],
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

export default function middleware(req) {
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
