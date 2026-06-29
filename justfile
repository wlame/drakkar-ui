# drakkar-ui — single dev entrypoint.
#
# Recipes wrap ./build.sh, which runs the whole Bun toolchain inside the
# oven/bun Docker image so the host installs nothing (see build.sh). CI runs the
# same `check` + `build` gates via oven-sh/setup-bun on an ephemeral runner — the
# underlying `bun run check` / `bun run build` commands are identical either way,
# so local and CI cannot disagree.
#
# Style: long flags use `=`, short flags use spaces.

set shell := ["bash", "-uc"]

# Version stamped from git tags (vX.Y.Z), or "dev" before the first tag.
version := `git describe --tags --dirty --always 2>/dev/null || echo dev`

# Show the recipe list.
default:
    @just --list --unsorted

# ── Build & dev ──────────────────────────────────────────────────────────────

# Build the oven/bun builder image (first-run prerequisite).
image:
    ./build.sh image

# Install dependencies from the committed lockfile (bun install).
install:
    ./build.sh install

# Run the Vite dev server (default port 5173), proxying /api + /ws to a backend.
# Override the target with DRAKKAR_BACKEND, e.g. DRAKKAR_BACKEND=http://host:8080.
dev port="5173":
    ./build.sh dev {{port}}

# Type-check the Svelte sources (svelte-check).
check:
    ./build.sh check

# Build the static SPA into dist/.
build:
    ./build.sh build

# Build + package dist/ into drakkar-ui-<ver>.tar.gz (index.html at archive root).
bundle ver=version:
    ./build.sh bundle {{ver}}

# Open an interactive shell in the builder image.
shell:
    ./build.sh shell

# Remove build output, the local tarball, and installed dependencies.
clean:
    rm -rf dist node_modules drakkar-ui-*.tar.gz

# ── Gates ────────────────────────────────────────────────────────────────────

# The exact gates GitHub CI enforces, in order. Run before pushing.
ci: image install check build

# ── Releasing (print-only for anything that mutates a remote) ─────────────────

# Validate, build the release tarball, tag vX.Y.Z, then PRINT the publish
# commands (never push automatically — see git-workflow).
release version:
    #!/usr/bin/env bash
    set -euo pipefail
    if [[ ! "{{version}}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        echo "error: version must be X.Y.Z (got '{{version}}')"; exit 1
    fi
    if [[ -n "$(git status --porcelain)" ]]; then
        echo "error: working tree is not clean"; exit 1
    fi
    if [[ "$(git rev-parse --abbrev-ref HEAD)" != "main" ]]; then
        echo "error: releases are cut from main"; exit 1
    fi
    just ci
    just bundle "v{{version}}"
    git tag -a "v{{version}}" -m "v{{version}}"
    echo
    echo "Tagged v{{version}}. To publish, run:"
    echo "    git push origin v{{version}}"
    if git remote get-url origin >/dev/null 2>&1 && command -v gh >/dev/null 2>&1; then
        echo "    gh release create v{{version}} drakkar-ui-v{{version}}.tar.gz --generate-notes"
    fi

# Compute the next version from the latest vX.Y.Z tag and run `release`.
bump level="patch":
    #!/usr/bin/env bash
    set -euo pipefail
    cur=$(git describe --tags --abbrev=0 2>/dev/null || echo v0.0.0)
    IFS=. read -r ma mi pa <<< "${cur#v}"
    case "{{level}}" in
        major) ma=$((ma+1)); mi=0; pa=0 ;;
        minor) mi=$((mi+1)); pa=0 ;;
        patch) pa=$((pa+1)) ;;
        *) echo "error: level must be major|minor|patch"; exit 1 ;;
    esac
    just release "${ma}.${mi}.${pa}"

# Print the version a build would stamp.
print-version:
    @echo {{version}}
