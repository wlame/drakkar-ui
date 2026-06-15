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

// Both backends now serve the versioned contract at /api/v1 (with legacy
// unprefixed /api aliases). DRAKKAR_API_UNVERSION=1 strips the /v1 segment when
// proxying, which is only useful against a Python build that predates its
// /api/v1 support — retire this flag once no such build matters.
const unversion = process.env.DRAKKAR_API_UNVERSION === '1'
const apiProxy = {
  target: backend,
  changeOrigin: true,
  ...(unversion ? { rewrite: (p: string) => p.replace(/^\/api\/v1/, '/api') } : {}),
}

export default defineConfig({
  plugins: [svelte()],
  // Stamp the bundle with its release version so operators can tell which UI
  // build a backend is serving. Set by build.sh/release.yml from the git tag;
  // "dev" for local untagged builds.
  define: {
    __APP_VERSION__: JSON.stringify(process.env.DRAKKAR_UI_VERSION ?? 'dev'),
  },
  build: {
    outDir: 'dist',
    // index.html lands at dist/ root; the release workflow tars dist/ contents
    // at the archive root so a backend's uihost fetcher finds index.html at the
    // top level.
    emptyOutDir: true,
  },
  server: {
    // The dev server runs inside a container and is reached by container
    // name (docker DNS) as well as localhost — allow any Host header. Dev
    // server only; the production bundle is static files.
    allowedHosts: true,
    proxy: {
      '/api': apiProxy,
      '/ws': { target: backend, ws: true, changeOrigin: true },
      '/healthz': { target: backend, changeOrigin: true },
      '/readyz': { target: backend, changeOrigin: true },
    },
  },
})
