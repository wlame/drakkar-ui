// UI model + helpers for the Live page. TaskView is the per-task shape the
// timeline and finished-table render; it is built from both the /api/v1/recent-tasks
// resync and the incremental WS frames.

import { parseAnnotation } from './events'
import type { RecentTask, RecentTasksResponse, WsEvent } from './types'

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
  // Parent-side share of the duration: how long starting the subprocess took
  // (task_completed metadata `spawn_ms`, v1.11 backends). WS-only — resyncs
  // preserve the WS-delivered value.
  spawn_ms: number | null
  // Time the task waited for a free pool slot before any work began
  // (task_started metadata `queue_wait_ms`, v1.11 backends). WS-only, like
  // spawn_ms. Long waits = the pool (or the CPUs behind it) is the bottleneck.
  queue_wait_ms: number | null
  // Run timing from the completion event (v1.29). `run_started_at` (unix
  // seconds of the spawn) and `reported_run_seconds` (the handler hook's run
  // time) come from both paths; `exit_notice_ms` (how late the worker handled
  // the exit) is WS-only, like spawn_ms. All null on older backends.
  run_started_at: number | null
  reported_run_seconds: number | null
  exit_notice_ms: number | null
}

// baseTaskId strips a `:r<ts>` retry suffix so links and lookups use the canonical id.
export function baseTaskId(id: string): string {
  return id.split(':r')[0]
}

// What the Live page actually consumes from a /recent-tasks response, after
// the payload has been vetted.
export interface NormalizedRecentTasks {
  tasks: RecentTask[]
  // null when the payload carried no usable lane count — the caller then keeps
  // the lane count it already had rather than collapsing the timeline.
  lane_count: number | null
  truncated: boolean
  // True when the payload is a placeholder rather than a measurement: the
  // backend flagged a degraded read, or the response did not have the
  // documented shape at all.
  unavailable: boolean
}

/**
 * Vet a /api/v1/recent-tasks response before the page iterates it.
 *
 * A degraded backend used to answer with a bare `[]`, which turned the
 * resync's `for (const t of payload.tasks)` into a TypeError — swallowed by
 * the surrounding catch, so the page silently froze on stale data. Current
 * backends send `{tasks: [], ..., unavailable: true}` instead, but an older
 * one still on the wire does not, so both are treated the same: no usable
 * task list means "unavailable", never "zero tasks".
 */
export function normalizeRecentTasks(payload: unknown): NormalizedRecentTasks {
  const obj =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Partial<RecentTasksResponse>)
      : null
  const lane_count =
    typeof obj?.lane_count === 'number' && obj.lane_count > 0 ? obj.lane_count : null
  const truncated = obj?.truncated === true
  const tasks = Array.isArray(obj?.tasks) ? (obj.tasks as RecentTask[]) : null
  if (tasks === null || obj?.unavailable === true) {
    return { tasks: [], lane_count, truncated, unavailable: true }
  }
  return { tasks, lane_count, truncated, unavailable: false }
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
    spawn_ms: null,
    queue_wait_ms: null,
    run_started_at: r.run_started_at ?? null,
    reported_run_seconds: r.reported_run_seconds ?? null,
    exit_notice_ms: null,
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
  // The order of a stream group in its message, from 0 (contract v1.32). Its
  // presence marks a group yielded by arrange_stream; null for an arrange()
  // window and on older backends.
  group_index?: number | null
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
  const isStreamGroup = arrange.group_index != null
  return annotations.filter((a) => {
    if (a.partition !== arrange.partition) return false
    // Every group of one message holds the same offset, so an annotation of
    // on_group_complete belongs to its group by window_id (contract v1.32).
    if (isStreamGroup && a.hook === 'on_group_complete') {
      return arrange.window_id != null && a.window_id === arrange.window_id
    }
    if (a.task_id != null) return taskIds.has(a.task_id)
    if (a.offset != null) return offsets.has(a.offset)
    return arrange.window_id != null && a.window_id === arrange.window_id
  })
}

// arrangeFromEvent builds an ArrangeView from an 'arranged' WS frame, parsing its
// metadata (offsets + task_ids live there).
export function arrangeFromEvent(e: WsEvent): ArrangeView {
  const m = parseMetadataObject(e.metadata)
  const offsets = Array.isArray(m.offsets) ? (m.offsets as number[]) : []
  const task_ids = Array.isArray(m.task_ids) ? (m.task_ids as string[]) : []
  const message_labels = Array.isArray(m.message_labels)
    ? (m.message_labels as string[])
    : (e.message_labels ?? [])
  const window_id = numberOr(m.window_id, null)
  const group_index = numberOr(m.group_index, null)
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
    group_index,
  }
}

// One on_group_complete() call for the Group Results tab (contract v1.32):
// one `group_complete` recorder row, flattened.
export interface GroupResultView {
  ts: number
  partition: number | null
  offset: number | null
  // Seconds spent in the on_group_complete() call.
  duration: number | null
  group_index: number | null
  window_id: number | null
  task_count: number
  succeeded: number
  failed: number
  replaced: number
  output_message_count: number
}

// The columns a group_complete row is read from. Both a /events row and a WS
// frame have this shape; every value is optional, so a malformed or older row
// still renders.
export interface GroupEventInput {
  ts: number
  partition?: number | null
  offset?: number | null
  duration?: number | null
  metadata?: string | null
}

function parseMetadataObject(metadata: string | null | undefined): Record<string, unknown> {
  if (!metadata) return {}
  try {
    const parsed: unknown = JSON.parse(metadata)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function numberOr<T>(value: unknown, fallback: T): number | T {
  return typeof value === 'number' ? value : fallback
}

/** Flatten one group_complete row; unknown or missing keys read as null or 0. */
export function groupResultFromEvent(e: GroupEventInput): GroupResultView {
  const m = parseMetadataObject(e.metadata)
  return {
    ts: e.ts,
    partition: e.partition ?? null,
    offset: e.offset ?? null,
    duration: e.duration ?? null,
    group_index: numberOr(m.group_index, null),
    window_id: numberOr(m.window_id, null),
    task_count: numberOr(m.task_count, 0),
    succeeded: numberOr(m.succeeded, 0),
    failed: numberOr(m.failed, 0),
    replaced: numberOr(m.replaced, 0),
    output_message_count: numberOr(m.output_message_count, 0),
  }
}

function groupResultKey(g: GroupResultView): string {
  return `${g.partition}:${g.offset}:${g.group_index}:${g.window_id}:${g.ts}`
}

/**
 * Fold a fresh /events snapshot of group rows into the rows the WS already
 * delivered. The snapshot is the base; a live row stays only when it is newer
 * than the snapshot's newest row and the snapshot does not hold it, so a
 * frame that landed while the request was in flight is neither lost nor
 * doubled. Newest first, at most `max` rows.
 */
export function mergeGroupResults(
  live: GroupResultView[],
  snapshot: GroupResultView[],
  max: number,
): GroupResultView[] {
  const newestSnapshotTs = snapshot.reduce((acc, g) => Math.max(acc, g.ts), -Infinity)
  const known = new Set(snapshot.map(groupResultKey))
  const fresh = live.filter((g) => g.ts > newestSnapshotTs && !known.has(groupResultKey(g)))
  return [...fresh, ...snapshot].sort((a, b) => b.ts - a.ts).slice(0, max)
}

/**
 * The list key of a Group Results row: its time, partition and window_id, or
 * offset and group_index when the row has no window_id, so two groups of one
 * message that end in the same millisecond keep apart.
 */
export function groupRowKey(g: GroupResultView): string {
  const id = g.window_id ?? `${g.offset}:${g.group_index}`
  return `${g.ts}:${g.partition}:${id}`
}

/** The group_count of a message_complete row (stream mode only), else null. */
export function messageGroupCount(metadata: string | null | undefined): number | null {
  return numberOr(parseMetadataObject(metadata).group_count, null)
}

/** The key the Message Results rows and the group counts share. */
export function messageKey(
  partition: number | null | undefined,
  offset: number | null | undefined,
): string {
  return `${partition ?? ''}:${offset ?? ''}`
}

/**
 * Map each message to its group count, read from message_complete rows given
 * newest first (as GET /api/v1/events answers). The newest row of a replayed
 * offset wins; rows without a group count (a list handler) are left out.
 */
export function groupCountsFromRows(
  rows: { partition?: number | null; offset?: number | null; metadata?: string | null }[],
): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const row of rows) {
    const key = messageKey(row.partition, row.offset)
    if (key in counts) continue
    const count = messageGroupCount(row.metadata)
    if (count !== null) counts[key] = count
  }
  return counts
}
