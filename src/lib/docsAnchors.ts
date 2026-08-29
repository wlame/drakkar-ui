// Contextual links into the operator docs site (contract v1.22). A backend
// that serves a prebuilt docs site under /docs/ declares it on identity as
// `docs: { title, anchors[] }`; each anchor binds a site path to one thing the
// UI already renders — a label key (optionally narrowed to one value), a sink
// name, an event type, or a declared page slug. The UI shows a docs
// affordance wherever a lookup here returns an anchor.
//
// Everything is optional and identity-driven: with no config set (older
// backend, or no docs site configured) every lookup returns null and the UI
// renders nothing extra. Malformed entries are skipped rather than thrown on
// — the same defensive posture as the rest of the identity surface, since one
// bad operator entry must not break a page.

import type { DocsAnchorWire, DocsConfig } from './types'

// Where the backend mounts the docs site. Same-origin path, not a base URL —
// see the built-in `docs` link base in the contract.
const DOCS_MOUNT = '/docs/'

// Module-level config store: set once from the identity fetch at boot (see
// setIdentity in config.ts), read by whatever renders a docs affordance.
let currentDocs: DocsConfig | null = null

export function setDocsConfig(cfg: DocsConfig | null): void {
  currentDocs = cfg ?? null
}

export function getDocsConfig(): DocsConfig | null {
  return currentDocs
}

// docsUrl turns an anchor's site-relative path into a URL under the docs
// mount, keeping any `#fragment` and collapsing a leading slash so the result
// never carries a double slash.
export function docsUrl(path: string): string {
  const relative = typeof path === 'string' ? path.replace(/^\/+/, '') : ''
  return DOCS_MOUNT + relative
}

// An entry is usable when it can actually produce a link: an object `match` to
// look it up by, and a non-blank `path` to point at. Anything else (a
// truncated entry, a wrong-typed field) is skipped by the lookups below.
function isUsableAnchor(entry: unknown): entry is DocsAnchorWire {
  if (typeof entry !== 'object' || entry === null) return false
  const anchor = entry as Partial<DocsAnchorWire>
  if (typeof anchor.path !== 'string' || anchor.path.trim() === '') return false
  return typeof anchor.match === 'object' && anchor.match !== null
}

function usableAnchors(): DocsAnchorWire[] {
  const declared = currentDocs?.anchors
  return Array.isArray(declared) ? declared.filter(isUsableAnchor) : []
}

// The three single-key match kinds resolve identically — only the `match`
// field they read differs — so they share one lookup keyed by that field
// rather than three near-identical functions.
type SingleMatchKey = 'sink' | 'event' | 'page'

function anchorForSingleMatch(key: SingleMatchKey, name: string): DocsAnchorWire | null {
  if (!name) return null
  return usableAnchors().find((anchor) => anchor.match[key] === name) ?? null
}

// anchorForLabel resolves a label chip, most specific match first: an anchor
// declared for this exact (key, value) pair beats the key-wide one. Called
// without a value it can only answer with the key-wide anchor.
export function anchorForLabel(key: string, value?: string): DocsAnchorWire | null {
  if (!key) return null
  const forKey = usableAnchors().filter((anchor) => anchor.match.label === key)
  if (value !== undefined) {
    const specific = forKey.find((anchor) => anchor.match.value === value)
    if (specific) return specific
  }
  return forKey.find((anchor) => anchor.match.value == null) ?? null
}

// anchorForSink resolves a configured sink instance name.
export function anchorForSink(name: string): DocsAnchorWire | null {
  return anchorForSingleMatch('sink', name)
}

// anchorForEvent resolves a recorder event type name.
export function anchorForEvent(typeName: string): DocsAnchorWire | null {
  return anchorForSingleMatch('event', typeName)
}

// anchorForPage resolves a declared user page slug.
export function anchorForPage(slug: string): DocsAnchorWire | null {
  return anchorForSingleMatch('page', slug)
}
