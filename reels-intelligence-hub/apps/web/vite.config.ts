import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Vite configuration.
 *
 * In development the API is proxied to the local Worker so the browser sees a
 * single origin and cookies work without CORS special-casing. In production the
 * built assets are served by the Worker itself (see DEPLOYMENT.md), so
 * `VITE_API_BASE_URL` is left empty and requests stay same-origin.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.VITE_API_PROXY_TARGET ?? 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    chunkSizeWarningLimit: 900,
  },
});
