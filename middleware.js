// Vercel edge middleware — runs in front of every /api/* request.
//
// Sole purpose: enable CORS for the Capacitor (native iOS/Android) shell.
//
// The native WebView origin is `https://localhost` (Capacitor's default
// HTTPS scheme handler) or `capacitor://localhost` on older configs. Our
// API lives at the production domain — so every native API call is
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
// Security: pairing with api/_lib/security.js requireSameOrigin —
// state-changing endpoints additionally check `X-Client-Platform`
// matches the Capacitor origin. So even if a hostile page somehow
// claimed `Origin: https://localhost`, it would still need to send the
// custom X-Client-Platform header (which triggers a real browser
// preflight, which only succeeds for Capacitor origins this middleware
// allows). Defense in depth.
import { next } from '@vercel/edge';

export const config = {
  // Only run on API routes. Don't touch HTML / asset routes (those use
  // the static headers block in vercel.json).
  matcher: '/api/:path*',
};

const NATIVE_ORIGINS = new Set([
  'https://localhost',   // Capacitor iOS (default since v5; HTTPS scheme)
  'capacitor://localhost', // older Capacitor iOS configs
  'http://localhost',    // Capacitor Android (default)
]);

const ALLOWED_HEADERS = [
  'Authorization',
  'Content-Type',
  'X-Client-Platform',
  'X-Requested-With',
  'Idempotency-Key',
].join(', ');

export default function middleware(req) {
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
