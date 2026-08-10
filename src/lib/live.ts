// UI model + helpers for the Live page. TaskView is the per-task shape the
// timeline and finished-table render; it is built from both the /api/v1/recent-tasks
// resync and the incremental WS frames.

import { parseAnnotation } from './events'
import type { RecentTask, WsEvent } from './types'

export type TaskStatus = 'running' | 'completed' | 'failed'

export interface TaskView {
  task_id: string
  partition: number | null
  start_ts: number
  end_ts: number | null
  duration: number | null
  status: TaskStatus
  exit_code: number | null
  args: string | null
  pid: number | null
  slot: number | null
  labels: Record<string, string> | null
  origin: string
  client_name: string | null
  request_id: string | null
  // stdout_size comes from both paths (WS task_completed frames and the
  // /recent-tasks resync, v1.7); stdout_lines arrives on WS frames only, and
  // stdin/env/source_offsets on WS task_started frames only — all kept
  // nullable and merged across resyncs so the finished-table Stdin/Stdout
  // columns, the timeline hover detail, and stdout_size color rules survive
  // a resync.
  stdout_size: number | null
  stdout_lines: number | null
  stdin_lines: number | null
  stdin_size: number | null
  env: Record<string, string> | null
  source_offsets: number[] | null
}

// baseTaskId strips a `:r<ts>` retry suffix so links and lookups use the canonical id.
export function baseTaskId(id: string): string {
  return id.split(':r')[0]
}

export function taskFromRecent(r: RecentTask): TaskView {
  return {
    task_id: r.task_id,
    partition: r.partition,
    start_ts: r.start_ts,
    end_ts: r.end_ts,
    duration: r.duration,
    status: r.status,
    exit_code: null,
    args: r.args,
    pid: r.pid,
    slot: r.slot,
    labels: r.labels,
    origin: r.origin,
    client_name: r.client_name,
    request_id: r.request_id,
    // Present since v1.7; an older backend omits it entirely.
    stdout_size: r.stdout_size ?? null,
    stdout_lines: null,
    stdin_lines: null,
    stdin_size: null,
    env: r.env,
    source_offsets: null,
  }
}

// One parsed arrange() call for the Arrange tab.
export interface ArrangeView {
  ts: number
  partition: number
  duration: number
  message_count: number
  task_count: number
  task_ids: string[]
  offsets: number[]
  message_labels: string[]
  // Per-partition monotone window counter (contract v1.3). Correlates this
  // batch with the annotations emitted from the same arrange() call. Older
  // backends omit it — null then, and annotations fall back to offset match.
  window_id: number | null
}

// AnnotationView is one live handler annotation, flattened from its WS frame.
export interface AnnotationView {
  ts: number
  partition: number
  kind: string
  scope: string
  hook: string
  window_id: number | null
  offset: number | null
  task_id: string | null
  data: Record<string, unknown>
}

// annotationFromEvent flattens an 'annotation' WS frame, or returns null when
// the frame is not one / its envelope is unusable.
export function annotationFromEvent(e: WsEvent): AnnotationView | null {
  const ann = parseAnnotation(e.event, e.metadata)
  if (!ann) return null
  return {
    ts: e.ts,
    partition: e.partition ?? -1,
    kind: ann.kind,
    scope: ann.scope,
    hook: ann.hook,
    window_id: ann.window_id,
    offset: e.offset ?? null,
    task_id: e.task_id ?? null,
    data: ann.data,
  }
}

// annotationsForArrange selects the annotations belonging to one arrange batch.
//
// Window-scoped rows match on window_id, which is why the arranged event
// carries it. Message- and task-scoped rows have no window_id of their own
// worth trusting across restarts, so they match on the batch's own offsets and
// task ids — the identifiers the batch already owns.
export function annotationsForArrange(
  annotations: AnnotationView[],
  arrange: ArrangeView,
): AnnotationView[] {
  const offsets = new Set(arrange.offsets)
  const taskIds = new Set(arrange.task_ids)
  return annotations.filter((a) => {
    if (a.partition !== arrange.partition) return false
    if (a.task_id != null) return taskIds.has(a.task_id)
    if (a.offset != null) return offsets.has(a.offset)
    return arrange.window_id != null && a.window_id === arrange.window_id
  })
}

// arrangeFromEvent builds an ArrangeView from an 'arranged' WS frame, parsing its
// metadata (offsets + task_ids live there).
export function arrangeFromEvent(e: WsEvent): ArrangeView {
  let offsets: number[] = []
  let task_ids: string[] = []
  let message_labels: string[] = e.message_labels ?? []
  let window_id: number | null = null
  if (e.metadata) {
    try {
      const m = JSON.parse(e.metadata) as Record<string, unknown>
      if (Array.isArray(m.offsets)) offsets = m.offsets as number[]
      if (Array.isArray(m.task_ids)) task_ids = m.task_ids as string[]
      if (Array.isArray(m.message_labels)) message_labels = m.message_labels as string[]
      if (typeof m.window_id === 'number') window_id = m.window_id
    } catch {
      // leave defaults
    }
  }
  return {
    ts: e.ts,
    partition: e.partition ?? -1,
    duration: e.duration ?? 0,
    message_count: e.message_count ?? offsets.length,
    task_count: e.task_count ?? task_ids.length,
    task_ids,
    offsets,
    message_labels,
    window_id,
  }
}
