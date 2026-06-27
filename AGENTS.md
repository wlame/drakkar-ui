# AGENTS.md — drakkar-ui

Orientation for LLM coding agents. Read this before deriving structure from
source.

## What this is

The **single web UI for every Drakkar backend** — a versioned static SPA
(Svelte 5 + Vite + TypeScript, zero runtime dependencies) built once,
published to GitHub Releases, and fetched/cached/served by any backend at
startup. The operator console looks and behaves identically whether the
worker underneath is the Python reference (`drakkar`) or the Go port
(`drakkar-go`).

```
tag vX.Y.Z → release.yml → drakkar-ui-vX.Y.Z.tar.gz (index.html at archive ROOT)
                                    │ fetched by both backends' uihost engines
                                    ▼
              ~/.cache/drakkar/ui/vX.Y.Z/   (ONE shared per-user cache per host)
                                    │ served at /  (History-API fallback)
                                    ▼
                       browser ⇄ /api/v1 JSON + /ws
```

## The contract — this repo owns it

**`docs/api-contract-v1.md` is the normative API spec** — a requirement this
repo places on backends, not documentation of them. Its machine-readable
twin is **`docs/openapi-v1.yaml`** (OpenAPI 3.1): both backends vendor it
byte-identically (`just sync-openapi` copies it to
`../drakkar/drakkar/uiserver/openapi.yaml` and
`../drakkar-go/internal/uiserver/openapi.yaml`), serve it at
`GET /api/v1/openapi.json` + a self-hosted Swagger page at `GET /docs`, and
pin their live route tables to its `paths` with a parity unit test — so
surface drift fails CI on the drifting backend. The UI only ever calls
`/api/v1/*` and `/ws` (probes `/healthz`/`/readyz` unprefixed) and assumes
nothing backend-specific. Changing an endpoint's shape means: update the
contract doc AND the OpenAPI spec, mirror the types in `src/lib/types.ts`,
re-sync the vendored copies, and land the change on BOTH backends. Optional
features are signaled by key presence (`webapp_tile`, `links`) or graceful
404s (`/identity` on older backends) — the UI must degrade, never crash,
when a key/endpoint is missing. As of v1.2, `/identity` also reports
`backend`, `backend_version`, `ui_version`, `ui_source`; the header
`VersionBadge` popover renders them (tolerating their absence).

Auth model: one optional bearer token; read from `?token=` (remembered in
`localStorage`), sent as `Authorization: Bearer`. WS handshakes and `<a>`
downloads can't set headers, so the token rides as `?token=` there
(`src/lib/api.ts`).

## Design decisions worth knowing

- **The UX is a faithful port of the Python backend's Jinja debug UI** — the
  polished reference. `pydrakkar/` is a gitignored read-only copy of that
  backend; `pydrakkar/drakkar/templates/*.html` are the source of truth for
  look, spacing, colors, formats, and polling cadences. When a visual
  question arises, diff against those templates (light "cream + ink" theme,
  dark `#2a2a2a` navbar, design tokens in `src/app.css`).
- **No framework router, no state library**: a hand-rolled History-API router
  (`src/lib/router.ts`, data-driven table in `src/lib/routes.ts`) and Svelte
  stores. Svelte 5 runes syntax throughout (`$state`/`$derived`/`$effect`).
- **Runtime config hydrates once at boot** from `GET /api/v1/live/overview`
  (`hydrateFromOverview` in `src/lib/config.ts`, called in `App.svelte`):
  Kafka-UI deep-link config, row caps, WS thresholds, hook flags. Safe
  defaults until the response lands.
- **Live page**: WebSocket `/ws` stream (reconnect 3s, freeze on Space) +
  5s DB resync via `/api/v1/recent-tasks`; retried tasks archive under
  composite keys `task_id:r<start_ts>` (server and client agree on this).
- **The bundle knows its version**: `__APP_VERSION__` is injected via Vite
  `define` from `DRAKKAR_UI_VERSION` (set by `build.sh bundle` and
  release.yml) and shown in the header — operators can always tell which
  release a backend serves. Local builds show `dev`.

## Toolchain — Docker only, one quirk

The host installs neither Node nor Bun; everything runs in the
`drakkar-ui-builder` image via `./build.sh` (thin `justfile` wraps it):

```bash
just ci          # image → install → check (svelte-check) → build; == GitHub CI
just dev         # Vite dev server :5173, proxying /api /ws /healthz /readyz
just bundle      # release-shaped tarball from the current tree
just release 0.1.0   # gates + tag; PRINTS the push command (never pushes)
```

**Quirk:** the dev server runs Vite under **node**, not bun — Bun's http layer
hangs Vite's `/ws` proxy upgrade (HTTP proxying works, WS frames never flow).
That's why the builder image carries a node binary and `build.sh dev` invokes
`node node_modules/vite/bin/vite.js`. Install/check/build stay on bun.

Dev-server targeting: `DRAKKAR_BACKEND=http://host:8081 just dev` (default
`host.docker.internal:8080`); `server.allowedHosts` is open because the
container is reached by docker DNS names.

## Release flow (what backends depend on)

Push of tag `vX.Y.Z` → `.github/workflows/release.yml` → builds with
`DRAKKAR_UI_VERSION=<tag>` → packages `drakkar-ui-vX.Y.Z.tar.gz` with
**`index.html` at the archive root** (asserted; backends validate the same
structurally) → creates the GitHub Release. Keep exactly ONE `.tar.gz` asset
per release, named by that convention — backends construct the direct
download URL from the tag (`releases/download/<tag>/drakkar-ui-<tag>.tar.gz`)
without touching the rate-limited REST API. Cut releases with
`just release X.Y.Z` / `just bump`, then push the printed tag.

## Directory map

```
src/
  main.ts, App.svelte     entry; layout, nav, boot-time config hydration
  app.css                 design tokens (cream/ink light theme)
  lib/
    api.ts                typed /api/v1 client (auth, ws/download URLs)
    types.ts              the contract shapes — mirror of docs/api-contract-v1.md
    router.ts, routes.ts  History-API router + data-driven route table
    config.ts             runtime config store + hydrateFromOverview
    ws.ts                 live WS client (reconnect, close codes 4401/4403)
    events.ts, format.ts, kafka.ts, live.ts   presentation helpers
  pages/                  one component per route (Dashboard … Live, Debug)
  components/             chrome (WorkerSwitcher, SinkLinks, VersionBadge …)
    live/                 Timeline, ArrangeTab, ResultsTab
    debug/                Metrics/Periodic/Trace/Probe/Cache/Databases tabs
docs/api-contract-v1.md   THE backend contract (normative)
docs/openapi-v1.yaml      its OpenAPI 3.1 twin — vendored into both backends
pydrakkar/                gitignored read-only Python backend copy (UX reference)
build.sh, justfile        dockerized toolchain + release recipes
.github/workflows/        ci.yml (check+build), release.yml (publish bundle)
```

## Gotchas

- `DRAKKAR_API_UNVERSION=1` (vite proxy strips `/v1`) exists only for Python
  builds predating their `/api/v1` support — both backends serve `/api/v1`
  now; don't reach for it.
- No test framework yet (svelte-check is the only gate) — adding vitest +
  lint to `ci` is the known next quality step.
- The SPA is served same-origin by backends; `API_BASE` is a relative
  `/api/v1` on purpose. Don't introduce absolute backend URLs.
- Bundle assets use absolute `/assets/...` URLs so deep routes load them;
  backends must (and do) serve the SPA from the site root.
