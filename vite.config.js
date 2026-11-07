import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Ivy's typeface, Neue Haas Grotesk, is licensed, so its files are not in
// the repository (docs/FONTS.md). An @font-face pointing at a missing file
// made every page request it, log a 404 and fall back. So each rule that
// loads a file from /fonts/ is kept only when that file is in public/fonts/:
// today the browser goes straight to the fallback stack (what it rendered
// anyway), and the day the .woff2 files are added, a rebuild switches the
// font on everywhere with no code change. Applies to the app's CSS
// (src/styles/fonts.css) and to the copies of public/*.css (blog.css).
const FONT_FACE = /@font-face\s*\{[^{}]*\}/g;
const FONT_FILE = /url\(\s*['"]?\/fonts\/([^'")\s]+)['"]?\s*\)/;
function keepPresentFontFaces(css, publicDir) {
  return css.replace(FONT_FACE, (rule) => {
    const file = rule.match(FONT_FILE)?.[1];
    if (!file) return rule;
    return fs.existsSync(path.join(publicDir, 'fonts', path.basename(file))) ? rule : '';
  });
}
function licensedFonts() {
  let publicDir = '';
  let outDir = '';
  return {
    name: 'ivy-licensed-fonts',
    enforce: 'pre',
    configResolved(config) {
      publicDir = config.publicDir;
      outDir = path.resolve(config.root, config.build.outDir);
    },
    transform(code, id) {
      if (!/\.css(\?|$)/.test(id) || !code.includes('@font-face')) return null;
      const out = keepPresentFontFaces(code, publicDir);
      return out === code ? null : { code: out, map: null };
    },
    closeBundle() {
      if (!publicDir || !fs.existsSync(publicDir)) return;
      for (const name of fs.readdirSync(publicDir)) {
        const file = path.join(outDir, name);
        if (!name.endsWith('.css') || !fs.existsSync(file)) continue;
        const css = fs.readFileSync(file, 'utf8');
        const out = keepPresentFontFaces(css, publicDir);
        if (out !== css) fs.writeFileSync(file, out);
      }
    },
  };
}

// Build-time identifier surfaced to the app via the __APP_VERSION__
// global so bug reports + error logs include a deploy fingerprint we
// can correlate to a commit. Vercel injects VERCEL_GIT_COMMIT_SHA on
// deploy builds; local dev falls back to 'dev'.
const APP_VERSION = process.env.VERCEL_GIT_COMMIT_SHA
  ? process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 7)
  : 'dev';

export default defineConfig({
  plugins: [react(), licensedFonts()],
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
    // Matched by module path: the object form ({ react: ['react', ...] })
    // only names the entry files, and React's CommonJS internals (react-dom,
    // scheduler) followed react-router into the router chunk, leaving an
    // empty react chunk.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'react';
          if (/[\\/]node_modules[\\/](react-router|react-router-dom|@remix-run[\\/]router)[\\/]/.test(id)) return 'router';
          return undefined;
        },
      },
    },
    // Route-split chunks land around 50–200 KB each; the warning's 500 KB
    // floor is dated for a SPA of this shape. Bumped so warnings only
    // surface when something genuinely regresses.
    chunkSizeWarningLimit: 700,
  },
});
