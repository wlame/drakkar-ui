// UI model + helpers for the Live page. TaskView is the per-task shape the
// timeline and finished-table render; it is built from both the /api/v1/recent-tasks
// resync and the incremental WS frames.

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
  stdout_size: number | null
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
    stdout_size: null,
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
}

// arrangeFromEvent builds an ArrangeView from an 'arranged' WS frame, parsing its
// metadata (offsets + task_ids live there).
export function arrangeFromEvent(e: WsEvent): ArrangeView {
  let offsets: number[] = []
  let task_ids: string[] = []
  let message_labels: string[] = e.message_labels ?? []
  if (e.metadata) {
    try {
      const m = JSON.parse(e.metadata) as Record<string, unknown>
      if (Array.isArray(m.offsets)) offsets = m.offsets as number[]
      if (Array.isArray(m.task_ids)) task_ids = m.task_ids as string[]
      if (Array.isArray(m.message_labels)) message_labels = m.message_labels as string[]
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
  }
}
