#!/usr/bin/env bash
# Dockerized Bun toolchain for drakkar-ui. The host never installs Node or Bun;
# every command runs inside the oven/bun image against the mounted source tree.
set -euo pipefail

IMAGE_NAME="drakkar-ui-builder"
BUN_VERSION="${BUN_VERSION:-latest}"

# Build the builder image (a thin oven/bun layer) if needed.
build_image() {
    docker build -t "$IMAGE_NAME" -f- . <<EOF
FROM oven/bun:${BUN_VERSION}
WORKDIR /app
EOF
}

# run_bun executes "bun <args>" inside the container with the repo mounted.
run_bun() {
    docker run --rm \
        -v "$(pwd):/app" \
        -w /app \
        "$IMAGE_NAME" \
        bun "$@"
}

install() { run_bun install; }
build()   { run_bun run build; }
check()   { run_bun run check; }

# dev runs the Vite dev server with hot reload. Pass a port (default 5173) and
# DRAKKAR_BACKEND to proxy /api + /ws at a running worker.
dev() {
    local port="${1:-5173}"
    docker run --rm -it \
        -v "$(pwd):/app" \
        -w /app \
        -p "${port}:${port}" \
        -e "DRAKKAR_BACKEND=${DRAKKAR_BACKEND:-http://host.docker.internal:8080}" \
        "$IMAGE_NAME" \
        bun run dev --host=0.0.0.0 --port="$port"
}

# bundle builds the static SPA and packages dist/ into a release-shaped tarball
# (index.html at the archive root) — the exact artifact the release workflow
# uploads and any Drakkar backend's uihost fetcher expects.
bundle() {
    local version="${1:-dev}"
    build
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
    dev)     dev "${2:-5173}" ;;
    bundle)  bundle "${2:-dev}" ;;
    shell)   shell ;;
    *)
        cat <<USAGE
Usage: $0 {image|install|build|check|dev|bundle|shell}

  image           build the oven/bun builder image
  install         install dependencies (bun install)
  build           build the static SPA into dist/ (bun run build)
  check           type-check the Svelte sources (svelte-check)
  dev [port]      run the Vite dev server (default 5173), proxying /api to a worker
  bundle [ver]    build + package dist/ into drakkar-ui-<ver>.tar.gz (release shape)
  shell           open an interactive shell in the builder image

First run:
  ./build.sh image && ./build.sh install && ./build.sh build
USAGE
        exit 1
        ;;
esac
