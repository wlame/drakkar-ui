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
//
// Anchors are validated and indexed once, at ingestion, because the lookups
// run in render hot paths: a label chip asks per cell, so a big table can ask
// thousands of times per render. Every anchorFor* is then a Map.get over the
// prebuilt index instead of a scan over the declared list.

import { writable } from 'svelte/store'

import { withAuthToken } from './api'
import type { DocsAnchorWire, DocsConfig } from './types'

// The anchor the docs drawer is currently showing, or null when it is
// closed. A store rather than a prop chain: the book icon appears in table
// cells, label chips and popovers all over the app, while the drawer itself
// is mounted once in App.svelte — threading a callback down every one of
// those paths would touch a dozen components that have no other stake in it.
export const openDocsAnchor = writable<DocsAnchorWire | null>(null)

// Where the backend mounts the docs site. Same-origin path, not a base URL —
// see the built-in `docs` link base in the contract.
const DOCS_MOUNT = '/docs/'

// Index keys are `<kind>:<name>`, with a value-narrowed label anchor keyed
// `label:<key>\0<value>`. A NUL is expressible in JSON, so a collision is not
// strictly impossible — but it needs an operator to put one inside a label
// key, and the worst case is one chip linking to the wrong docs page.
const VALUE_SEP = '\0'

// Module-level config store: set once from the identity fetch at boot (see
// setIdentity in config.ts), read by whatever renders a docs affordance.
let currentDocs: DocsConfig | null = null
let anchorIndex = new Map<string, DocsAnchorWire>()

export function setDocsConfig(cfg: DocsConfig | null): void {
  currentDocs = cfg ?? null
  anchorIndex = buildIndex(currentDocs)
}

export function getDocsConfig(): DocsConfig | null {
  return currentDocs
}

// docsUrl turns an anchor's site-relative path into a URL under the docs
// mount, keeping any `#fragment` and collapsing a leading slash so the result
// never carries a double slash.
//
// The docs site is auth-gated exactly like the SPA, and the surfaces that open
// these URLs — the drawer's iframe, the nav link, "open in new tab" — are
// browser-issued requests that cannot carry an Authorization header. So a
// configured token rides as a query param, the same convention the WS
// handshake and the DB downloads already use. Single source: every docs link
// in the UI, the nav entry included, is built here.
export function docsUrl(path: string): string {
  const relative = typeof path === 'string' ? path.replace(/^\/+/, '') : ''
  return withAuthToken(DOCS_MOUNT + relative)
}

// A path with a `..` segment is rejected outright: the contract forbids it,
// and the browser would normalize /docs/../../admin back out of the docs
// mount into an arbitrary same-origin request. Percent-encoded dots are
// decoded first — a URL parser resolves %2e%2e (and the mixed .%2e form) as
// a dot segment too, so the raw split alone would wave them through.
function hasTraversalSegment(path: string): boolean {
  return path.replace(/%2e/gi, '.').split(/[/\\]/).includes('..')
}

// An entry is usable when it can actually produce a safe link: an object
// `match` to look it up by, and a non-blank, non-traversing `path` to point
// at. Anything else (a truncated entry, a wrong-typed field, an escape
// attempt) never reaches the index.
function isUsableAnchor(entry: unknown): entry is DocsAnchorWire {
  if (typeof entry !== 'object' || entry === null) return false
  const anchor = entry as Partial<DocsAnchorWire>
  if (typeof anchor.path !== 'string' || anchor.path.trim() === '') return false
  if (hasTraversalSegment(anchor.path)) return false
  return typeof anchor.match === 'object' && anchor.match !== null
}

// The three single-key match kinds resolve identically — only the `match`
// field they name differs — so the kinds are data rather than three
// near-identical lookups.
type SingleMatchKey = 'sink' | 'event' | 'page'
const SINGLE_MATCH_KEYS: SingleMatchKey[] = ['sink', 'event', 'page']

function selectorName(match: DocsAnchorWire['match'], key: string): string | null {
  const name = match[key as keyof DocsAnchorWire['match']]
  return typeof name === 'string' && name !== '' ? name : null
}

// Every index key one entry answers to. A well-formed entry carries exactly
// one selector, but a malformed one carrying several is indexed under each of
// them rather than dropped — the lookups stay the arbiter of what matches.
function indexKeysFor(anchor: DocsAnchorWire): string[] {
  const keys: string[] = []
  const labelKey = selectorName(anchor.match, 'label')
  if (labelKey !== null) {
    const value = selectorName(anchor.match, 'value')
    keys.push(value !== null ? `label:${labelKey}${VALUE_SEP}${value}` : `label:${labelKey}`)
  }
  for (const kind of SINGLE_MATCH_KEYS) {
    const name = selectorName(anchor.match, kind)
    if (name !== null) keys.push(`${kind}:${name}`)
  }
  return keys
}

// buildIndex validates the declared anchors once and maps each usable one to
// the keys it answers to. First declaration wins on a duplicate key, which is
// what a top-to-bottom scan of the list used to do.
function buildIndex(cfg: DocsConfig | null): Map<string, DocsAnchorWire> {
  const index = new Map<string, DocsAnchorWire>()
  const declared = cfg?.anchors
  if (!Array.isArray(declared)) return index
  for (const entry of declared) {
    if (!isUsableAnchor(entry)) continue
    for (const key of indexKeysFor(entry)) {
      if (!index.has(key)) index.set(key, entry)
    }
  }
  return index
}

// anchorForLabel resolves a label chip, most specific match first: an anchor
// declared for this exact (key, value) pair beats the key-wide one. Called
// without a value it can only answer with the key-wide anchor.
export function anchorForLabel(key: string, value?: string): DocsAnchorWire | null {
  if (!key) return null
  if (value !== undefined) {
    const specific = anchorIndex.get(`label:${key}${VALUE_SEP}${value}`)
    if (specific) return specific
  }
  return anchorIndex.get(`label:${key}`) ?? null
}

function anchorForSingleMatch(kind: SingleMatchKey, name: string): DocsAnchorWire | null {
  if (!name) return null
  return anchorIndex.get(`${kind}:${name}`) ?? null
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
