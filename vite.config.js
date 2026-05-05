import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    open: false,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    // Group big third-party libs into vendor chunks so they cache long-term
    // independently of our app code. Pure caching win — when we redeploy a
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
