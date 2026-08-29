// Enrichment helpers for probe-details links, badges and value formats
// (declarative UI enrichment). Templates support three token kinds:
// {value} = the cell value, {row.<field>} = a sibling field on the same row,
// {<base>} = a named base URL delivered on the identity payload
// (GET /api/v1/identity -> link_bases).
//
// Two resolvers share the same token grammar and null semantics (missing
// base / missing-or-null row field / null value -> the whole resolution
// fails) but differ in how a substitution is rendered: resolveTemplate is
// for hrefs, so {value}/{row.*} are percent-encoded and the base is
// inserted raw (it's a trusted URL prefix, not user/row data); resolveText
// is for plain display text (panel titles, hint tooltips) and never
// encodes — "o 1" must read as "o 1", not "o%201".
//
// One href-only extra: a template that resolves onto the same-origin operator
// docs mount gets the auth token appended (see withDocsAuthToken, which the
// timeline's own link resolver shares).

import { withAuthToken } from './api'
import { fmtTimeFull } from './format'

export type LinkBases = Record<string, string>

const TOKEN_RE = /\{([A-Za-z_][A-Za-z0-9_.]*)\}/g

// The identity link base naming the same-origin operator docs mount
// (contract v1.22 ships a built-in `"docs": "/docs"`).
const DOCS_BASE_NAME = 'docs'

// Module-level bases store: set once from the identity fetch at boot, read by
// whatever renders links (UserDetailsTab, the detail side panel).
let currentBases: LinkBases = {}

export function setLinkBases(bases: LinkBases): void {
  currentBases = bases ?? {}
}

export function getLinkBases(): LinkBases {
  return currentBases
}

export interface TemplateContext {
  value?: unknown
  row?: Record<string, unknown>
  bases: LinkBases
}

// walkTemplate is the shared token parser behind resolveTemplate and
// resolveText: it substitutes every {value}/{row.<field>}/{<base>} token,
// running each {value}/{row.*} substitution through `encodeSubstitution`
// (identity for plain text, percent-encoding for hrefs). The base itself is
// never passed through the encoder — it's a trusted URL prefix either way.
// Returns null — never a partial result — when any token fails to resolve,
// so callers can fall back to plain text instead of a broken link or a
// title with a hole in it.
function walkTemplate(
  tpl: string,
  ctx: TemplateContext,
  encodeSubstitution: (raw: string) => string,
): string | null {
  let failed = false
  const out = tpl.replace(TOKEN_RE, (_match, token: string) => {
    if (token === 'value') {
      if (ctx.value === null || ctx.value === undefined) {
        failed = true
        return ''
      }
      return encodeSubstitution(String(ctx.value))
    }
    if (token.startsWith('row.')) {
      const field = ctx.row?.[token.slice('row.'.length)]
      if (field === null || field === undefined) {
        failed = true
        return ''
      }
      return encodeSubstitution(String(field))
    }
    const base = ctx.bases[token]
    if (!base) {
      failed = true
      return ''
    }
    return base
  })
  return failed ? null : out
}

// isUnderDocsMount reports whether a resolved href lands on the docs mount the
// backend declared on identity. The character after the mount must be a
// boundary, so a user base like '/docsearch' is not mistaken for the mount.
function isUnderDocsMount(url: string, bases: LinkBases): boolean {
  const mount = bases[DOCS_BASE_NAME]
  if (!mount || !url.startsWith(mount)) return false
  const boundary = url.charAt(mount.length)
  return boundary === '' || boundary === '/' || boundary === '?' || boundary === '#'
}

/**
 * Appends the auth token to a fully resolved href that lands on the operator
 * docs mount, leaving every other URL untouched.
 *
 * The docs mount is auth-gated like the SPA, and a template link is opened by
 * the browser (an `<a>`, an iframe src) — neither can carry the Authorization
 * header. So a `{docs}` link gets the same `?token=` treatment docsUrl() gives
 * the contextual anchors.
 *
 * It runs on the finished URL and never on the base itself: templates
 * concatenate path segments after a base (`{docs}/page.html#frag`), so a base
 * ending in `?token=x` would corrupt every URL built from it. withAuthToken is
 * fragment-safe and joins onto a query the template already carries.
 *
 * Shared by both template resolvers — this one and resolveEventLink in
 * timelineEvents.ts — so the two cannot disagree about docs links.
 */
export function withDocsAuthToken(url: string, bases: LinkBases): string {
  return isUnderDocsMount(url, bases) ? withAuthToken(url) : url
}

/** Expands a link template into an href: {value}/{row.*} substitutions are percent-encoded. */
export function resolveTemplate(tpl: string, ctx: TemplateContext): string | null {
  const url = walkTemplate(tpl, ctx, encodeURIComponent)
  return url === null ? null : withDocsAuthToken(url, ctx.bases)
}

/** Expands a template into plain display text (panel titles, hint tooltips): substitutions render literally, unencoded. */
export function resolveText(tpl: string, ctx: TemplateContext): string | null {
  return walkTemplate(tpl, ctx, (raw) => raw)
}

// badgeColor maps a badge value through its color map, falling back to the
// '*' wildcard key. Returns the CSS class suffix (e.g. 'green') or null when
// the value is unmapped and no wildcard is declared — callers render an
// unstyled value in that case rather than guessing a color.
export function badgeColor(colors: Record<string, string>, value: string): string | null {
  return colors[value] ?? colors['*'] ?? null
}

// formatDurationMs renders a millisecond duration as "N ms" below one second,
// otherwise "M m S s" (minutes omitted once they hit zero). Kept local to
// enrich.ts rather than reusing format.ts's duration helpers: those all take
// *seconds* and use a denser "5s"/"1m 5s" style tuned for the live feed,
// while probe-details formats declare their own ms-based literal.
function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  const totalSeconds = Math.round(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes === 0 ? `${seconds} s` : `${minutes} m ${seconds} s`
}

// formatBytesBinary renders a byte count in binary units (KiB/MiB/...) with
// one decimal above the base unit. format.ts's fmtBytes is decimal-labeled
// (KB/MB) for its existing call sites, so this is a distinct implementation
// rather than a reuse — the probe-details 'bytes' format is declared binary.
const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB']

function formatBytesBinary(bytes: number): string {
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024
    unitIndex++
  }
  return unitIndex === 0
    ? `${value} ${BYTE_UNITS[unitIndex]}`
    : `${value.toFixed(1)} ${BYTE_UNITS[unitIndex]}`
}

// formatValue renders a raw value under a declared format kind
// ('duration_ms' | 'bytes' | 'timestamp' | 'number'). Falsy/unknown formats
// and inputs that don't conform to the expected type (e.g. a non-numeric
// value under 'bytes') pass through as String(value) rather than throwing —
// probe-details data is user-declared and not guaranteed to match its
// format hint.
export function formatValue(format: string | undefined | null, value: unknown): string {
  if (format === 'duration_ms' && typeof value === 'number' && Number.isFinite(value)) {
    return formatDurationMs(value)
  }
  if (format === 'bytes' && typeof value === 'number' && Number.isFinite(value)) {
    return formatBytesBinary(value)
  }
  if (format === 'number' && typeof value === 'number' && Number.isFinite(value)) {
    return value.toLocaleString('en-US')
  }
  if (format === 'timestamp' && typeof value === 'string') {
    const epochMs = Date.parse(value)
    if (!Number.isNaN(epochMs)) return fmtTimeFull(epochMs / 1000)
  }
  return String(value)
}
