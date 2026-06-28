#!/usr/bin/env bash
# Dockerized Bun toolchain for drakkar-ui. The host never installs Node or Bun;
# every command runs inside the oven/bun image against the mounted source tree.
set -euo pipefail

IMAGE_NAME="drakkar-ui-builder"
BUN_VERSION="${BUN_VERSION:-latest}"

# Build the builder image (a thin oven/bun layer) if needed. Node is added
# alongside Bun solely for the dev server: Bun's http compatibility layer
# hangs vite's /ws proxy upgrade (HTTP proxying works, WebSocket frames
# never flow), so `dev` runs vite under node while install/build/check stay
# on bun.
build_image() {
    docker build -t "$IMAGE_NAME" -f- . <<EOF
FROM node:22-bookworm-slim AS node
FROM oven/bun:${BUN_VERSION}
COPY --from=node /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
EOF
}

# run_bun executes "bun <args>" inside the container with the repo mounted.
# DRAKKAR_UI_VERSION is forwarded so vite can stamp the bundle (see vite.config.ts).
run_bun() {
    docker run --rm \
        -v "$(pwd):/app" \
        -w /app \
        -e "DRAKKAR_UI_VERSION=${DRAKKAR_UI_VERSION:-dev}" \
        "$IMAGE_NAME" \
        bun "$@"
}

install() { run_bun install; }
build()   { run_bun run build; }
check()   { run_bun run check; }
lint()    { run_bun run lint; }
fmt()     { run_bun run format; }
# "tests", not "test": never shadow the shell builtin.
tests()   { run_bun run test; }

# dev runs the Vite dev server with hot reload. Pass a port (default 5173) and
# DRAKKAR_BACKEND to proxy /api + /ws at a running worker. host.docker.internal
# is mapped to the host gateway explicitly so the default backend URL also
# resolves on Linux (Docker Desktop provides it out of the box, plain dockerd
# does not).
dev() {
    local port="${1:-5173}"
    docker run --rm -it \
        -v "$(pwd):/app" \
        -w /app \
        -p "${port}:${port}" \
        --add-host=host.docker.internal:host-gateway \
        -e "DRAKKAR_BACKEND=${DRAKKAR_BACKEND:-http://host.docker.internal:8080}" \
        "$IMAGE_NAME" \
        node node_modules/vite/bin/vite.js --host=0.0.0.0 --port="$port"
}

# bundle builds the static SPA and packages dist/ into a release-shaped tarball
# (index.html at the archive root) — the exact artifact the release workflow
# uploads and any Drakkar backend's uihost fetcher expects.
bundle() {
    local version="${1:-dev}"
    DRAKKAR_UI_VERSION="$version" build
    local tarball="drakkar-ui-${version}.tar.gz"
    tar -czf "$tarball" -C dist .
    echo "packaged ${tarball}:"
    tar -tzf "$tarball" | head
}

shell() {
    docker run --rm -it -v "$(pwd):/app" -w /app "$IMAGE_NAME" /bin/sh
}

case "${1:-help}" in
    image)   build_image ;;
    install) install ;;
    build)   build ;;
    check)   check ;;
    lint)    lint ;;
    format)  fmt ;;
    test)    tests ;;
    dev)     dev "${2:-5173}" ;;
    bundle)  bundle "${2:-dev}" ;;
    shell)   shell ;;
    *)
        cat <<USAGE
Usage: $0 {image|install|build|check|lint|format|test|dev|bundle|shell}

  image           build the oven/bun builder image
  install         install dependencies (bun install)
  build           build the static SPA into dist/ (bun run build)
  check           type-check the Svelte sources (svelte-check)
  lint            prettier --check + eslint (no writes)
  format          prettier --write (rewrites sources in place)
  test            run the vitest unit suite (hermetic, no backend needed)
  dev [port]      run the Vite dev server (default 5173), proxying /api to a worker
  bundle [ver]    build + package dist/ into drakkar-ui-<ver>.tar.gz (release shape)
  shell           open an interactive shell in the builder image

First run:
  ./build.sh image && ./build.sh install && ./build.sh build
USAGE
        exit 1
        ;;
esac
