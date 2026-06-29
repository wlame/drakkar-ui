import { writable } from 'svelte/store'

// A minimal History-API router. The bundle is served with an index.html
// fallback for unknown paths (each backend's uihost SPA handler), so
// client-side routing works without any server-side route config: the server
// always returns the shell, and these stores decide which page renders.
//
// Three reactive stores track the location so pages can react to deep state:
//   currentPath — pathname        (which page; drives route resolution. Named
//                                  currentPath, not `path`, so it never collides
//                                  with the SVG <path> element used across pages.)
//   search — raw query string     (e.g. "?page=2"; partition-detail pager)
//   hash   — raw fragment         (e.g. "#trace/5/42"; debug tabs + trace deep-link)
export const currentPath = writable(window.location.pathname)
export const search = writable(window.location.search)
export const hash = writable(window.location.hash)

function syncFromLocation(): void {
  currentPath.set(window.location.pathname)
  search.set(window.location.search)
  hash.set(window.location.hash)
}

// navigate performs a client-side route change. `to` may include a query string
// and/or hash (e.g. "/partitions/3?page=1", "/debug#trace/5/42").
export function navigate(to: string): void {
  const current = window.location.pathname + window.location.search + window.location.hash
  if (to === current) return
  window.history.pushState({}, '', to)
  syncFromLocation()
}

// setHash updates only the fragment. Used for in-page state like the debug tab or
// the trace deep-link; `replace` avoids piling up history entries on every keystroke.
export function setHash(fragment: string, opts: { replace?: boolean } = {}): void {
  const url = window.location.pathname + window.location.search + fragment
  if (opts.replace) {
    window.history.replaceState({}, '', url)
  } else {
    window.history.pushState({}, '', url)
  }
  hash.set(fragment)
}

// setQuery replaces the query string on the current path (keeps the hash).
export function setQuery(query: string, opts: { replace?: boolean } = {}): void {
  const q = query && !query.startsWith('?') ? `?${query}` : query
  const url = window.location.pathname + q + window.location.hash
  if (opts.replace) {
    window.history.replaceState({}, '', url)
  } else {
    window.history.pushState({}, '', url)
  }
  search.set(q)
}

// Reflect browser back/forward and fragment changes into the stores.
window.addEventListener('popstate', syncFromLocation)
window.addEventListener('hashchange', () => hash.set(window.location.hash))

// link is a Svelte action: `<a href="/x" use:link>` intercepts the click and
// routes client-side instead of triggering a full page reload. External and
// modified (cmd/ctrl/middle-click) navigations fall through to the browser.
export function link(node: HTMLAnchorElement) {
  const onClick = (e: MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      return
    }
    const href = node.getAttribute('href')
    if (!href || href.startsWith('http') || node.target === '_blank') return
    e.preventDefault()
    navigate(href)
  }
  node.addEventListener('click', onClick)
  return { destroy: () => node.removeEventListener('click', onClick) }
}
