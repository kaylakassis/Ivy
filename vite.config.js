import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Build-time identifier surfaced to the app via the __APP_VERSION__
// global so bug reports + error logs include a deploy fingerprint we
// can correlate to a commit. Vercel injects VERCEL_GIT_COMMIT_SHA on
// deploy builds; local dev falls back to 'dev'.
const APP_VERSION = process.env.VERCEL_GIT_COMMIT_SHA
  ? process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 7)
  : 'dev';

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  server: {
    port: 5173,
    open: false,
  },
  build: {
    outDir: 'dist',
    // No public source maps. Vite writes them into dist/, and everything in
    // dist/ is served, so `true` published the entire front-end source
    // (comments included) to anyone who asked for the .map URL. Sentry
    // stack traces are minified as a result; if that ever matters, upload
    // maps to Sentry at build time instead of shipping them.
    sourcemap: false,
    // Group big third-party libs into vendor chunks so they cache long-term
    // independently of our app code. Pure caching win - when we redeploy a
    // copy edit, returning users only re-download the small index chunk.
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom'],
          router: ['react-router-dom'],
        },
      },
    },
    // Route-split chunks land around 50–200 KB each; the warning's 500 KB
    // floor is dated for a SPA of this shape. Bumped so warnings only
    // surface when something genuinely regresses.
    chunkSizeWarningLimit: 700,
  },
});
