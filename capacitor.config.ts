// Capacitor config - wraps the Vite-built SPA as a native iOS app.
//
// Distribution model: BUNDLED (the contents of dist/ are copied into the
// .ipa, no remote `server.url`). On `npx cap sync ios` the build is
// snapshotted into ios/App/App/public. This means every functional
// change ships as a normal App Store update - Apple will not reject for
// "thin web wrapper" the way they would if we set server.url to the
// live web app.
//
// Why we don't use server.hostname to host the bundle from our real
// domain: Capacitor's URL-scheme handler intercepts ALL requests under
// the configured hostname and tries to serve from the bundle, so a
// bundled `getivyos.com` would 404 every `/api/*` call. Instead the
// WebView lives at the default capacitor:// origin and the API client
// (src/lib/api.js) prepends an absolute base URL on native (VITE_API_BASE_URL).
// Cross-origin XHR is handled with CORS headers (vercel.json) +
// Authorization: Bearer auth (api/_lib/auth.js readSession).
const config = {
  appId: 'com.getivyos.app',
  appName: 'Ivy OS',
  webDir: 'dist',
  ios: {
    // Standard WebKit content inset behavior - prevents iOS bouncing
    // the whole web view when the user scrolls past the top, which
    // looks broken on a sticky-header app.
    contentInset: 'never',
    // Background color for the brief flash between native splash
    // dismiss and first paint of the WebView. Matches our cream `--page`.
    backgroundColor: '#F5F1E8',
  },
  // No server.url in prod - bundled assets only. For local dev against
  // a running vite server you can override this at build time via env
  // (Capacitor reads CAPACITOR_SERVER_URL etc.); intentionally omitted
  // from the static config so prod builds don't accidentally point at
  // an external URL.
  server: {
    // iOS WebView origin becomes `https://localhost` (not `capacitor://`).
    // Some third-party SDKs (Stripe.js, OAuth providers) reject the
    // capacitor scheme as an invalid origin; https://localhost is treated
    // as a normal secure origin everywhere. CORS allowlist in vercel.json
    // matches this exact origin.
    iosScheme: 'https',
    androidScheme: 'https',
  },
};

export default config;
