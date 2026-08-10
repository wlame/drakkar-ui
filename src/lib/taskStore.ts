// Shared task-state builder for the live timelines: folds WS task events and
// /recent-tasks resync rows into one `Record<task_id, TaskView>` map. Used by
// the Live page for its own worker and by PeerTimeline for every cluster peer,
// so the two views cannot drift in how they read the same event stream.

import { safeJsonParse } from './format'
import { taskFromRecent, type TaskView } from './live'
import type { RecentTask, WsEvent } from './types'

/**
 * Fold one WS task event into the map (mutating it in place — the callers
 * hold the map in Svelte `$state`, whose deep proxy turns these mutations
 * into fine-grained updates).
 *
 * Retries: a second task_started for an id archives the previous attempt
 * under the composite `task_id:r<start_ts>` key, exactly as the server's
 * /recent-tasks grouping does — INCLUDING rewriting the archived copy's own
 * `task_id` field to that key. Two TaskViews must never share a task_id: it
 * is the key of the timeline's `{#each}`, and a duplicate crashes the whole
 * render (Svelte each_key_duplicate).
 *
 * Events other than task_started/task_completed/task_failed are ignored.
 */
export function applyTaskEvent(tasks: Record<string, TaskView>, e: WsEvent): void {
  switch (e.event) {
    case 'task_started': {
      if (!e.task_id) return
      const existing = tasks[e.task_id]
      if (existing) {
        const archiveId = `${e.task_id}:r${existing.start_ts}`
        tasks[archiveId] = {
          ...existing,
          task_id: archiveId,
          // A still-running previous attempt can never finish now — its
          // completion event would land on the new attempt. Close it as
          // failed at the moment the retry started (the server's grouping
          // makes the same call).
          end_ts: existing.end_ts ?? e.ts,
          status: existing.status === 'running' ? 'failed' : existing.status,
          duration: existing.duration ?? e.ts - existing.start_ts,
        }
      }
      // The recorder's task_started metadata carries env + source_offsets
      // (used by the timeline hover detail).
      const meta = safeJsonParse<Record<string, unknown>>(e.metadata ?? undefined, {})
      tasks[e.task_id] = {
        task_id: e.task_id,
        partition: e.partition ?? null,
        start_ts: e.ts,
        end_ts: null,
        duration: null,
        status: 'running',
        exit_code: null,
        args: e.args ?? null,
        pid: e.pid ?? null,
        slot: e.slot ?? null,
        labels: safeJsonParse(e.labels ?? undefined, null),
        origin: e.origin ?? 'kafka',
        client_name: e.client_name ?? null,
        request_id: e.request_id ?? null,
        stdout_size: null,
        stdout_lines: null,
        stdin_lines: e.stdin_lines ?? null,
        stdin_size: e.stdin_size ?? null,
        env: (meta.env as Record<string, string> | undefined) ?? null,
        source_offsets: Array.isArray(meta.source_offsets)
          ? (meta.source_offsets as number[])
          : null,
      }
      return
    }
    case 'task_completed':
    case 'task_failed': {
      if (!e.task_id) return
      const done = e.event === 'task_completed' ? 'completed' : 'failed'
      const ex = tasks[e.task_id]
      const start = ex?.start_ts ?? e.ts - (e.duration ?? 0)
      tasks[e.task_id] = {
        task_id: e.task_id,
        partition: e.partition ?? ex?.partition ?? null,
        start_ts: start,
        end_ts: e.ts,
        duration: e.duration ?? (ex ? e.ts - ex.start_ts : null),
        status: done,
        exit_code: e.exit_code ?? null,
        args: ex?.args ?? e.args ?? null,
        pid: e.pid ?? ex?.pid ?? null,
        slot: ex?.slot ?? e.slot ?? null,
        labels: ex?.labels ?? safeJsonParse(e.labels ?? undefined, null),
        origin: e.origin ?? ex?.origin ?? 'kafka',
        client_name: e.client_name ?? ex?.client_name ?? null,
        request_id: e.request_id ?? ex?.request_id ?? null,
        stdout_size: e.stdout_size ?? null,
        stdout_lines: e.stdout_lines ?? null,
        stdin_lines: ex?.stdin_lines ?? e.stdin_lines ?? null,
        stdin_size: ex?.stdin_size ?? e.stdin_size ?? null,
        env: ex?.env ?? null,
        source_offsets: ex?.source_offsets ?? null,
      }
      return
    }
  }
}

/**
 * Build the post-resync map from one good /recent-tasks payload, merging in
 * the WS-only fields the previous map may hold.
 *
 * /recent-tasks doesn't carry stdin/stdout_lines/env/source_offsets/exit_code
 * — keep the WS-provided values so the hover detail and exit_code color rules
 * survive resyncs. stdout_size comes from both paths, so take whichever side
 * actually has it rather than letting one wipe the other (an older backend
 * omits it from the resync row; the WS frame is missing for a task that
 * finished before the page connected).
 */
export function mergeRecentTasks(
  prev: Record<string, TaskView>,
  rows: RecentTask[],
): Record<string, TaskView> {
  const map: Record<string, TaskView> = {}
  for (const t of rows) {
    const v = taskFromRecent(t)
    const old = prev[t.task_id]
    if (old) {
      v.stdin_lines = old.stdin_lines
      v.stdin_size = old.stdin_size
      v.stdout_size = v.stdout_size ?? old.stdout_size
      v.stdout_lines = old.stdout_lines
      v.env = v.env ?? old.env
      v.source_offsets = old.source_offsets
      v.exit_code = v.exit_code ?? old.exit_code
    }
    map[t.task_id] = v
  }
  return map
}

/**
 * Drop finished tasks that ended before `cutoffTs` (unix seconds).
 *
 * Peer timelines have no DB resync to rebuild their map from (the peers'
 * REST API is another origin), so without this sweep their maps would grow
 * for as long as cluster view stays open. Running tasks are always kept.
 */
export function pruneFinishedBefore(tasks: Record<string, TaskView>, cutoffTs: number): void {
  for (const [id, t] of Object.entries(tasks)) {
    if (t.end_ts != null && t.end_ts < cutoffTs) delete tasks[id]
  }
}

/**
 * Lane count derived from the slots actually seen, with a floor.
 *
 * The Live page learns its lane count from /recent-tasks; a peer timeline
 * cannot ask (cross-origin), so it starts from the current worker's lane
 * count — workers of one cluster run the same executor config in practice —
 * and grows only when a peer's own tasks prove a higher slot exists.
 */
export function laneCountFromTasks(tasks: TaskView[], minimum: number): number {
  let lanes = minimum
  for (const t of tasks) {
    if (t.slot != null && t.slot + 1 > lanes) lanes = t.slot + 1
  }
  return lanes
}
