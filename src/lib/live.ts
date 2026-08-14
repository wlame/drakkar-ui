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

// One reading from the backend's net_io WS heartbeat: host-wide network
// throughput in MiB/s (the whole network namespace — worker, subprocesses,
// and any neighbours sharing it; per-process accounting needs root/eBPF).
//
// The optional NFS pair (contract v1.11) exists because the namespace's
// interface counters CANNOT see kernel-NFS traffic from inside a container
// — the host's NFS client moves those bytes through the host's interfaces.
// Backends sample /proc/self/mountstats for it; absent keys mean no NFS
// mount is visible (or an older backend), and the readout stays hidden.
export interface NetRates {
  rx_mib_s: number
  tx_mib_s: number
  nfs_read_mib_s?: number
  nfs_write_mib_s?: number
}

// netFromEvent extracts the RX/TX rates from a 'net_io' WS frame, or returns
// null when the frame is not one / its metadata is unusable. Frames arrive
// every state-sync tick (default 10s) from backends that support them;
// absence is normal on older backends and on hosts without /proc/net/dev.
export function netFromEvent(e: WsEvent): NetRates | null {
  if (e.event !== 'net_io' || !e.metadata) return null
  try {
    const m = JSON.parse(e.metadata) as Record<string, unknown>
    if (typeof m.rx_mib_s !== 'number' || typeof m.tx_mib_s !== 'number') return null
    const rates: NetRates = { rx_mib_s: m.rx_mib_s, tx_mib_s: m.tx_mib_s }
    // NFS keys are carried only when BOTH are well-formed numbers — a frame
    // with one usable half would render a misleading readout.
    if (typeof m.nfs_read_mib_s === 'number' && typeof m.nfs_write_mib_s === 'number') {
      rates.nfs_read_mib_s = m.nfs_read_mib_s
      rates.nfs_write_mib_s = m.nfs_write_mib_s
    }
    return rates
  } catch {
    return null
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
