// Event-type semantics shared by the History, Trace, Partition-detail, Task-detail
// and Live pages. The Python reference encodes these as inline Tailwind classes;
// here they are data (a lookup table) keyed by event name, using the reference's
// saturated 600-level shades that read well on the light cream/ink palette.

// Semantic palette — saturated enough to sit on the light surfaces in app.css.
export const COLOR = {
  blue: '#2563eb',
  teal: '#0d9488',
  amber: '#d97706',
  emerald: '#059669',
  red: '#dc2626',
  purple: '#9333ea',
  violet: '#7c3aed',
  lilac: '#8b5cf6',
  magenta: '#c026d3',
  gray: '#6b7280',
  http: '#9333ea',
} as const

// EVENT_COLORS maps a recorder event name to its accent color. Unknown events
// fall back to the muted gray via eventColor().
export const EVENT_COLORS: Record<string, string> = {
  consumed: COLOR.blue,
  arranged: COLOR.teal,
  task_started: COLOR.amber,
  task_completed: COLOR.emerald,
  task_failed: COLOR.red,
  task_complete: COLOR.purple,
  message_complete: COLOR.violet,
  window_complete: COLOR.lilac,
  produced: COLOR.magenta,
  committed: COLOR.gray,
}

export function eventColor(event: string): string {
  return EVENT_COLORS[event] ?? COLOR.gray
}

// EVENT_TYPES is the History page's filter set, in display order (matches the
// checkboxes in history.html). The reference shipped a stale "< 8" threshold for
// deciding whether to send the filter; the SPA instead compares against this
// full set, so unchecking any single type takes effect immediately.
export const EVENT_TYPES = [
  'consumed',
  'arranged',
  'task_started',
  'task_completed',
  'task_failed',
  'task_complete',
  'message_complete',
  'window_complete',
  'produced',
  'committed',
] as const

export type TaskStatus = 'running' | 'completed' | 'failed' | 'unknown'

// statusColor maps a derived task status to its accent color (task detail summary,
// Live status cells, timeline bars).
export function statusColor(status: TaskStatus | string | null | undefined): string {
  switch (status) {
    case 'completed':
      return COLOR.emerald
    case 'failed':
      return COLOR.red
    case 'running':
      return COLOR.amber
    default:
      return COLOR.gray
  }
}

// durationColor flags slow durations the way the reference does: > 1s red,
// > 0.1s amber, otherwise emerald. Nullish → muted.
export function durationColor(seconds: number | null | undefined): string {
  if (seconds == null) return COLOR.gray
  if (seconds > 1) return COLOR.red
  if (seconds > 0.1) return COLOR.amber
  return COLOR.emerald
}
