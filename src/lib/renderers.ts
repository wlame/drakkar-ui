// Loads the deployment's custom cell-renderer module (GET
// /api/v1/ui/renderers.js, served only when the backend has
// ui.custom_renderers_module configured — see Identity.custom_renderers) into
// a small in-memory registry. The module's default export is a plain object
// mapping renderer names to functions; CustomCell.svelte looks them up by
// name at render time.
//
// Loading is opt-in and best-effort: a deployment with nothing configured, a
// network failure, or a malformed module must never break the page that
// asked for a renderer — it just falls back to plain text (CustomCell's
// job). This module's only responsibility is "never throw, warn once".

import { downloadUrl } from './api'

// A deployment-provided cell renderer: receives the raw cell value, the
// full row (undefined for scalar fields), and a small context object.
export type RendererFn = (
  value: unknown,
  row: Record<string, unknown> | undefined,
  cell: { key?: string },
) => HTMLElement

// The raw dynamic import, factored out behind a mutable holder rather than
// called inline. Two reasons: the module specifier is a runtime URL (backend
// host + optional ?token=), which Vite cannot statically analyze — hence the
// `/* @vite-ignore */` below — and there is no repo precedent for mocking a
// computed-specifier `import()` with vi.mock (it intercepts static import
// statements, not calls with a runtime string). Routing the call through
// `_importModule.load` lets tests substitute a stub without touching the
// module system or performing a real network fetch.
function defaultImportModule(url: string): Promise<unknown> {
  return import(/* @vite-ignore */ url)
}

export const _importModule: { load: (url: string) => Promise<unknown> } = {
  load: defaultImportModule,
}

// null = not loaded yet or reset; otherwise the resolved (possibly empty)
// registry. `loadCustomRenderers` makes the load idempotent via loadPromise,
// not via checking `registry`, so concurrent callers before the first load
// resolves all await the same import rather than racing a second one.
let registry: Record<string, unknown> | null = null
let loadPromise: Promise<void> | null = null

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Dynamically imports the backend-served module. Never throws: any failure
// (network, parse, bad default export) leaves the registry empty with one
// console.warn. Idempotent — repeat calls reuse the first import.
export async function loadCustomRenderers(): Promise<void> {
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const mod = (await _importModule.load(downloadUrl('/ui/renderers.js'))) as {
          default?: unknown
        }
        if (!isPlainObject(mod?.default)) {
          throw new Error('renderers.js default export is not a plain object')
        }
        registry = mod.default
      } catch (err) {
        registry = {}
        console.warn(
          'loadCustomRenderers: failed to load the backend-served renderers module; custom cell rendering is disabled.',
          err,
        )
      }
    })()
  }
  return loadPromise
}

// Returns the named renderer, or null when the module is absent, the name
// is unknown, or the entry is not a function.
//
// The renderer-name grammar (^[a-zA-Z_][a-zA-Z0-9_]*$) admits 'constructor',
// 'toString', 'hasOwnProperty', and other Object.prototype member names, so a
// plain `registry?.[name]` lookup would silently resolve those to inherited
// functions instead of a real "not registered" miss. Object.hasOwn gates the
// lookup to the module's own declared entries.
export function getRenderer(name: string): RendererFn | null {
  if (!registry || !Object.hasOwn(registry, name)) return null
  const entry = registry[name]
  return typeof entry === 'function' ? (entry as RendererFn) : null
}

// Test hook: reset module state.
export function resetRenderersForTest(): void {
  registry = null
  loadPromise = null
  _importModule.load = defaultImportModule
}
