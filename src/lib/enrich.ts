// Enrichment helpers for probe-details links, badges and value formats
// (declarative UI enrichment, phase 1). Templates support three token kinds:
// {value} = the cell value, {row.<field>} = a sibling field on the same row,
// {<base>} = a named base URL delivered on the identity payload
// (GET /api/v1/identity -> link_bases). value/row substitutions are
// percent-encoded; the base itself is inserted raw since it is a trusted URL
// prefix, not user/row data.

import { fmtTimeFull } from './format'

export type LinkBases = Record<string, string>

const TOKEN_RE = /\{([A-Za-z_][A-Za-z0-9_.]*)\}/g

// Module-level bases store: set once from the identity fetch at boot, read by
// whatever renders links (UserDetailsTab, the detail side panel).
let currentBases: LinkBases = {}

export function setLinkBases(bases: LinkBases): void {
  currentBases = bases ?? {}
}

export function getLinkBases(): LinkBases {
  return currentBases
}

// resolveTemplate expands a link/hint template against a value, an optional
// sibling row, and the link bases. Returns null — never a partial URL — when
// a referenced base is unconfigured or a referenced row/value field is
// missing or null, so callers can fall back to plain text instead of
// rendering a broken link.
export function resolveTemplate(
  tpl: string,
  ctx: { value?: unknown; row?: Record<string, unknown>; bases: LinkBases },
): string | null {
  let failed = false
  const out = tpl.replace(TOKEN_RE, (_match, token: string) => {
    if (token === 'value') {
      if (ctx.value === null || ctx.value === undefined) {
        failed = true
        return ''
      }
      return encodeURIComponent(String(ctx.value))
    }
    if (token.startsWith('row.')) {
      const field = ctx.row?.[token.slice('row.'.length)]
      if (field === null || field === undefined) {
        failed = true
        return ''
      }
      return encodeURIComponent(String(field))
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
