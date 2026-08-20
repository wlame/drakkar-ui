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
  annotation: COLOR.http,
  // Contract v1.10: one row per handler.offload() call (CPU-bound hook
  // work moved to the backend's thread pool). Teal like `arranged` — it
  // is arrange-adjacent work — but distinguishable via its own label.
  offload: COLOR.teal,
  // Runtime-health family (contract v1.15): state/lag samples, hard
  // stalls, lag episodes with verdicts, opt-in probes — red-adjacent, they
  // exist to explain bad moments. resource_sample is the neutral host
  // telemetry next to them.
  runtime_health: COLOR.amber,
  runtime_stall: COLOR.red,
  runtime_lag_episode: COLOR.red,
  runtime_probe: COLOR.gray,
  resource_sample: COLOR.blue,
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
  'annotation',
  'offload',
  'resource_sample',
  'runtime_health',
  'runtime_stall',
  'runtime_lag_episode',
  'runtime_probe',
] as const

// An annotation event's metadata envelope (contract v1.3). Handler-emitted
// diagnostics: `data` is the user's arbitrary payload, never partially written
// (a backend drops an over-budget payload whole rather than truncating it, so a
// row that exists carries a complete document).
export type Annotation = {
  kind: string
  scope: 'message' | 'task' | 'window' | string
  hook: string
  window_id: number | null
  offsets: number[]
  data: Record<string, unknown>
}

// parseAnnotation reads the envelope out of an event's metadata column, or
// returns null when the row is not an annotation or the envelope is malformed.
// Defensive by contract: column *presence* is pinned, values are not, and the
// UI must tolerate an older or newer backend.
export function parseAnnotation(
  event: string,
  metadata: string | null | undefined,
): Annotation | null {
  if (event !== 'annotation' || !metadata) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(metadata)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const env = parsed as Record<string, unknown>
  if (typeof env.kind !== 'string') return null
  return {
    kind: env.kind,
    scope: typeof env.scope === 'string' ? env.scope : 'window',
    hook: typeof env.hook === 'string' ? env.hook : '',
    window_id: typeof env.window_id === 'number' ? env.window_id : null,
    offsets: Array.isArray(env.offsets) ? (env.offsets as number[]) : [],
    data: env.data && typeof env.data === 'object' ? (env.data as Record<string, unknown>) : {},
  }
}

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
