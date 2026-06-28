// Formatting helpers shared across pages. These mirror the Python reference's
// server-side formatters (drakkar/debug/server_helpers.py) and the inline JS in
// the Jinja templates, so the SPA renders timestamps, durations and sizes
// identically. Everything is rendered in UTC — operators correlate events across
// workers by absolute time, so local-time conversion is deliberately avoided.

// Timestamps from the contract are Unix epoch *seconds* (float), except the cache
// browser which uses *milliseconds* (see fmtDateTimeMs).

// fmtTime renders an epoch-seconds timestamp as UTC HH:MM:SS. Empty for nullish.
export function fmtTime(ts: number | null | undefined): string {
  if (ts == null) return ''
  return new Date(ts * 1000).toISOString().substring(11, 19)
}

// fmtTimeMs renders UTC HH:MM:SS.mmm — used for hover tooltips where sub-second
// ordering matters.
export function fmtTimeMs(ts: number | null | undefined): string {
  if (ts == null) return ''
  return new Date(ts * 1000).toISOString().substring(11, 23)
}

// fmtTimeFull renders UTC YYYY-MM-DD HH:MM:SS.mmm (the reference's format_ts_full).
export function fmtTimeFull(ts: number | null | undefined): string {
  if (ts == null) return ''
  return new Date(ts * 1000).toISOString().replace('T', ' ').substring(0, 23)
}

// fmtDateTimeMs renders an epoch-*milliseconds* timestamp as UTC
// YYYY-MM-DD HH:MM:SS. The cache table stores ms, unlike everything else.
export function fmtDateTimeMs(ms: number | null | undefined): string {
  if (ms == null) return '-'
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ')
}

// durSec formats a duration in seconds the way the Live feed does: sub-second
// values as whole milliseconds, otherwise two decimals. Nullish → '-'.
export function durSec(s: number | null | undefined): string {
  if (s == null) return '-'
  if (s < 1) return `${Math.round(s * 1000)}ms`
  return `${s.toFixed(2)}s`
}

// dur2 formats seconds with two decimals + 's' (partition detail / history rows,
// matching the reference's "%.2f"|format(duration)+"s").
export function dur2(s: number | null | undefined): string {
  if (s == null) return '-'
  return `${s.toFixed(2)}s`
}

// dur3 formats seconds with three decimals + 's' (task detail / timeline rows).
export function dur3(s: number | null | undefined): string {
  if (s == null) return '-'
  return `${s.toFixed(3)}s`
}

// fmtLatency formats an end-to-end latency adaptively: ms under a second, seconds
// under a minute, otherwise minutes (matches the Live page's fmtLatency).
export function fmtLatency(s: number | null | undefined): string {
  if (s == null) return '-'
  if (s < 1) return `${Math.round(s * 1000)}ms`
  if (s < 60) return `${s.toFixed(1)}s`
  return `${(s / 60).toFixed(1)}m`
}

// fmtBytes formats a byte count as B / KB / MB (1 decimal above bytes). Nullish → '-'.
export function fmtBytes(n: number | null | undefined): string {
  if (n == null) return '-'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

const MINUTE = 60
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const MONTH = 30 * DAY
const YEAR = 365 * DAY

// fmtUptime scales an uptime in seconds to its two largest units, mirroring the
// reference's format_uptime (server_helpers.py). The input is floored first.
export function fmtUptime(seconds: number): string {
  const total = Math.floor(seconds)
  if (total < MINUTE) return `${total}s`
  if (total < HOUR) return `${Math.floor(total / MINUTE)}m ${total % MINUTE}s`
  if (total < DAY) return `${Math.floor(total / HOUR)}h ${Math.floor((total % HOUR) / MINUTE)}m`
  if (total < MONTH) return `${Math.floor(total / DAY)}d ${Math.floor((total % DAY) / HOUR)}h`
  if (total < YEAR) return `${Math.floor(total / MONTH)}mo ${Math.floor((total % MONTH) / DAY)}d`
  return `${Math.floor(total / YEAR)}y ${Math.floor((total % YEAR) / MONTH)}mo`
}

// fmtAgo renders a relative "N<unit> ago" for an epoch-seconds timestamp, using
// the most significant unit (matches the debug page's fmtAgo). Nullish → '-'.
export function fmtAgo(ts: number | null | undefined): string {
  if (!ts) return '-'
  const delta = Date.now() / 1000 - ts
  if (delta < MINUTE) return `${Math.floor(delta)}s ago`
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m ago`
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h ago`
  return `${Math.floor(delta / DAY)}d ago`
}

// safeJsonParse parses a JSON string column (args/metadata/labels are stored as
// JSON text), returning a fallback when the value is nullish or malformed.
export function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (value == null) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}
