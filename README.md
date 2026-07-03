# drakkar-ui

The web UI for [Drakkar](https://github.com/wlame/drakkar) workers — a single,
**versioned static single-page app** that every Drakkar backend serves, so the
operator console looks and behaves identically no matter which backend
implementation (the Python reference or the Go port) is running.

drakkar-ui ships **decoupled** from the backends. It is built once, published to
GitHub Releases as a static bundle, and each backend fetches that bundle at
startup, caches it, and serves it. There is no UI code inside the backends — only
a small host that resolves and serves whichever bundle version it is pinned to.

```
        ┌────────────── drakkar-ui (this repo) ──────────────┐
        │  Svelte + Vite SPA  ──build──►  dist/  ──tar.gz──►  │
        └───────────────────────────┬────────────────────────┘
                                     │  GitHub Release asset
                                     ▼
   any Drakkar backend  ──fetch──►  ~/.cache/drakkar/ui/<version>  ──serve──►  browser
   (Python or Go)         (cached; embedded fallback if offline)        │
                                     ▲                                   │
                                     └────────── /api/v1 JSON ───────────┘
```

## The contract

drakkar-ui is backend-agnostic because every backend implements one identical,
versioned JSON/WS contract under **`/api/v1`** (probes `/healthz` and `/readyz`
stay unprefixed). The UI only ever talks to `/api/v1/*` and `/ws`; it never
assumes anything backend-specific. The contract is a requirement this repo
places on backends — the full endpoint catalog and canonical response shapes
are pinned in [`docs/api-contract-v1.md`](docs/api-contract-v1.md).

Auth follows the backend's opt-in model: when a bearer token is configured, the
UI reads it from a `?token=` query parameter (remembered in `localStorage`) and
sends it as `Authorization: Bearer …`. With no token configured — the dev-trust
default — requests are unauthenticated.

## Develop

The toolchain runs entirely inside Docker (`oven/bun`); you do **not** install
Node or Bun on the host. The `build.sh` wrapper drives it:

```bash
./build.sh image      # build the oven/bun builder image (first run)
./build.sh install    # bun install
./build.sh dev        # Vite dev server on :5173, proxying /api + /ws to a worker
./build.sh build      # produce the static bundle in dist/
./build.sh check      # type-check the Svelte sources
./build.sh bundle v1.2.0   # build + package dist/ into a release-shaped tarball
```

`dev` proxies `/api`, `/ws`, `/healthz`, and `/readyz` to a running Drakkar
worker so you iterate against live data. Point it at a specific worker with
`DRAKKAR_BACKEND=http://host:8080 ./build.sh dev`.

## Build & release

A push of a `vX.Y.Z` tag triggers `.github/workflows/release.yml`, which builds
the bundle and publishes it as a GitHub Release asset:

```
drakkar-ui-vX.Y.Z.tar.gz
```

The tarball is packaged so that **`index.html` sits at the archive root** (the
workflow asserts this), because that is exactly the shape a backend's bundle
fetcher expects: it selects the first `.tar.gz` asset and requires `index.html`
at the top level. `vite build` emits `dist/index.html` plus `dist/assets/…`; the
workflow runs `tar -czf … -C dist .` so those files land at the archive root.

## How a backend consumes a release

On the Go backend the bundle host lives in `internal/uihost`, is configured with
`DK_UI__*` settings, and is **off by default** (the backend keeps its built-in
HTML pages until a real drakkar-ui release is pinned):

```bash
DK_UI__ENABLED=true
DK_UI__RELEASE_REPO=wlame/drakkar-ui
DK_UI__PINNED_VERSION=v1.2.0
# optional: DK_UI__CACHE_DIR, DK_UI__CHECK_UPDATE
```

Resolution order is graceful and never fatal: a cached bundle for the pinned
version → otherwise fetch that version from GitHub Releases → otherwise the
embedded fallback baked into the binary (works fully offline). A companion CLI
manages the cache directly:

```bash
drakkar-ui where                       # where the cache is + what would be served
drakkar-ui fetch --version=v1.2.0      # download a specific release into the cache
drakkar-ui update                      # download the latest release into the cache
```

## Project layout

```
src/
  main.ts            SPA entry (Svelte 5 mount)
  App.svelte         top-level layout + nav (boot-hydrates runtime config)
  app.css            global light "cream + ink" theme (design tokens)
  lib/
    router.ts        minimal History-API router (store + <a use:link>)
    routes.ts        data-driven route table (path → page component)
    api.ts           typed client for the /api/v1 contract
    types.ts         the contract shapes (mirrors docs/api-contract-v1.md)
    config.ts        shared runtime config (kafka-ui links, tuning)
    ws.ts            live WebSocket client (reconnect, freeze)
    events.ts, format.ts, kafka.ts, live.ts   presentation helpers
  pages/             one component per route (Dashboard … Live, Debug)
  components/        shared chrome + live/ and debug/ tab components
docs/                api-contract-v1.md — the backend contract this UI consumes
public/              static assets copied to the bundle root (favicon)
build.sh             Dockerized Bun toolchain
.github/workflows/   ci.yml (build + type-check), release.yml (publish bundle)
```

## Status

All operator pages of the Python reference UI are implemented against the v1
contract: Dashboard, Partitions (+ detail), Task detail, History, Sinks, the
WebSocket-fed Live pipeline view (arrange/execute timeline + completion-hook
tabs), and the Debug tools page (metrics, periodic, trace, message probe, cache
browser, databases). The build and release pipeline is in place; test coverage
and a visual parity audit against the reference UI are the current focus.

## License

MIT © wlame
