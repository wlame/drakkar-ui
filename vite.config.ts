import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// The bundle is served at the site root by any Drakkar backend (the debug
// server mounts it at "/"), so asset URLs are absolute ("/assets/..."). That
// is what lets History-API client routing work at any depth: a deep route like
// /task/123 still loads /assets/app.js, not /task/assets/app.js.
//
// During local `vite dev`, requests under /api and /ws are proxied to a running
// Drakkar backend (default :8080) so the UI talks to a real worker while you
// iterate. Point it elsewhere with DRAKKAR_BACKEND.
const backend = process.env.DRAKKAR_BACKEND ?? 'http://127.0.0.1:8080'

// The Go backend serves the versioned contract at /api/v1; the Python reference
// (pydrakkar) serves the same shapes UNVERSIONED at /api. Set
// DRAKKAR_API_UNVERSION=1 to strip the /v1 segment when proxying, so the SPA can
// run against the Python reference for parity checks. Off by default (the
// production target is the Go backend, which keeps /v1).
const unversion = process.env.DRAKKAR_API_UNVERSION === '1'
const apiProxy = {
  target: backend,
  changeOrigin: true,
  ...(unversion ? { rewrite: (p: string) => p.replace(/^\/api\/v1/, '/api') } : {}),
}

export default defineConfig({
  plugins: [svelte()],
  build: {
    outDir: 'dist',
    // index.html lands at dist/ root; the release workflow tars dist/ contents
    // at the archive root so a backend's uihost fetcher finds index.html at the
    // top level.
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': apiProxy,
      '/ws': { target: backend, ws: true, changeOrigin: true },
      '/healthz': { target: backend, changeOrigin: true },
      '/readyz': { target: backend, changeOrigin: true },
    },
  },
})
