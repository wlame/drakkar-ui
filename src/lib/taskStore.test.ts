import { describe, it, expect } from 'vitest'
import {
  applyTaskEvent,
  laneCountFromTasks,
  mergeRecentTasks,
  pruneFinishedBefore,
} from './taskStore'
import type { TaskView } from './live'
import type { RecentTask, WsEvent } from './types'

function started(over: Partial<WsEvent> = {}): WsEvent {
  return { event: 'task_started', ts: 100, task_id: 't1', partition: 0, slot: 2, ...over }
}

function completed(over: Partial<WsEvent> = {}): WsEvent {
  return { event: 'task_completed', ts: 105, task_id: 't1', duration: 5, ...over }
}

describe('applyTaskEvent', () => {
  it('creates a running task from task_started, parsing metadata env and offsets', () => {
    const tasks: Record<string, TaskView> = {}
    applyTaskEvent(
      tasks,
      started({ metadata: JSON.stringify({ env: { K: 'v' }, source_offsets: [7, 8] }) }),
    )
    const t = tasks['t1']
    expect(t.status).toBe('running')
    expect(t.start_ts).toBe(100)
    expect(t.end_ts).toBeNull()
    expect(t.env).toEqual({ K: 'v' })
    expect(t.source_offsets).toEqual([7, 8])
  })

  it('finishes a known task, keeping the started-side fields', () => {
    const tasks: Record<string, TaskView> = {}
    applyTaskEvent(tasks, started({ args: 'run', stdin_lines: 3, stdin_size: 42 }))
    applyTaskEvent(tasks, completed({ exit_code: 0, stdout_size: 10, stdout_lines: 2 }))
    const t = tasks['t1']
    expect(t.status).toBe('completed')
    expect(t.duration).toBe(5)
    expect(t.args).toBe('run')
    expect(t.stdin_lines).toBe(3)
    expect(t.stdout_lines).toBe(2)
  })

  it('parses spawn_ms from task_completed metadata and keeps it across resyncs', () => {
    const tasks: Record<string, TaskView> = {}
    applyTaskEvent(tasks, started())
    applyTaskEvent(tasks, completed({ metadata: JSON.stringify({ spawn_ms: 12.5 }) }))
    expect(tasks['t1'].spawn_ms).toBe(12.5)
    const merged = mergeRecentTasks(tasks, [
      {
        task_id: 't1',
        partition: 0,
        start_ts: 100,
        end_ts: 105,
        duration: 5,
        status: 'completed',
        args: null,
        pid: null,
        slot: 0,
        labels: null,
        env: null,
        origin: 'kafka',
        client_name: null,
        request_id: null,
      },
    ])
    expect(merged['t1'].spawn_ms).toBe(12.5)
  })

  it('leaves spawn_ms null when the completion carries no metadata', () => {
    const tasks: Record<string, TaskView> = {}
    applyTaskEvent(tasks, started())
    applyTaskEvent(tasks, completed())
    expect(tasks['t1'].spawn_ms).toBeNull()
  })

  it('derives the start from ts - duration when the start event was missed', () => {
    const tasks: Record<string, TaskView> = {}
    applyTaskEvent(tasks, completed({ ts: 110, duration: 4 }))
    expect(tasks['t1'].start_ts).toBe(106)
    expect(tasks['t1'].status).toBe('completed')
  })

  it('marks task_failed as failed', () => {
    const tasks: Record<string, TaskView> = {}
    applyTaskEvent(tasks, started())
    applyTaskEvent(tasks, { event: 'task_failed', ts: 103, task_id: 't1', exit_code: 1 })
    expect(tasks['t1'].status).toBe('failed')
    expect(tasks['t1'].exit_code).toBe(1)
  })

  it('archives a finished previous attempt under the composite retry key', () => {
    const tasks: Record<string, TaskView> = {}
    applyTaskEvent(tasks, started({ ts: 100 }))
    applyTaskEvent(tasks, completed({ ts: 105 }))
    applyTaskEvent(tasks, started({ ts: 110 }))
    const archived = tasks['t1:r100']
    // The archived copy's OWN task_id must be the composite key: task_id is
    // the timeline's each-key, and a duplicate crashes the whole render.
    expect(archived.task_id).toBe('t1:r100')
    expect(archived.status).toBe('completed')
    expect(tasks['t1'].status).toBe('running')
    expect(tasks['t1'].start_ts).toBe(110)
  })

  it('closes a still-running previous attempt as failed at the retry start', () => {
    const tasks: Record<string, TaskView> = {}
    applyTaskEvent(tasks, started({ ts: 100 }))
    applyTaskEvent(tasks, started({ ts: 110 }))
    const archived = tasks['t1:r100']
    expect(archived.status).toBe('failed')
    expect(archived.end_ts).toBe(110)
    expect(archived.duration).toBe(10)
  })

  it('never leaves two entries sharing one task_id', () => {
    const tasks: Record<string, TaskView> = {}
    applyTaskEvent(tasks, started({ ts: 100 }))
    applyTaskEvent(tasks, completed({ ts: 105 }))
    applyTaskEvent(tasks, started({ ts: 110 }))
    applyTaskEvent(tasks, completed({ ts: 115 }))
    const ids = Object.values(tasks).map((t) => t.task_id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('ignores frames without a task id and non-task events', () => {
    const tasks: Record<string, TaskView> = {}
    applyTaskEvent(tasks, { event: 'task_started', ts: 1 })
    applyTaskEvent(tasks, { event: 'arranged', ts: 1, task_id: 'x' })
    expect(Object.keys(tasks)).toEqual([])
  })
})

describe('mergeRecentTasks', () => {
  const row: RecentTask = {
    task_id: 't1',
    partition: 0,
    start_ts: 100,
    end_ts: 105,
    duration: 5,
    status: 'completed',
    args: 'run',
    pid: 1,
    slot: 0,
    labels: null,
    env: null,
    origin: 'kafka',
    client_name: null,
    request_id: null,
  }

  it('keeps the WS-only fields from the previous map', () => {
    const tasks: Record<string, TaskView> = {}
    applyTaskEvent(tasks, started({ stdin_lines: 3, stdin_size: 42 }))
    applyTaskEvent(tasks, completed({ exit_code: 0, stdout_size: 10, stdout_lines: 2 }))
    const merged = mergeRecentTasks(tasks, [row])
    expect(merged['t1'].stdin_lines).toBe(3)
    expect(merged['t1'].stdout_size).toBe(10)
    expect(merged['t1'].stdout_lines).toBe(2)
    expect(merged['t1'].exit_code).toBe(0)
  })

  it('drops entries the resync no longer returns', () => {
    const tasks: Record<string, TaskView> = {}
    applyTaskEvent(tasks, started({ task_id: 'gone' }))
    const merged = mergeRecentTasks(tasks, [row])
    expect(Object.keys(merged)).toEqual(['t1'])
  })
})

describe('pruneFinishedBefore', () => {
  it('drops finished tasks older than the cutoff, keeps running ones', () => {
    const tasks: Record<string, TaskView> = {}
    applyTaskEvent(tasks, started({ task_id: 'old', ts: 10 }))
    applyTaskEvent(tasks, completed({ task_id: 'old', ts: 20 }))
    applyTaskEvent(tasks, started({ task_id: 'ancient-running', ts: 5 }))
    applyTaskEvent(tasks, started({ task_id: 'fresh', ts: 90 }))
    applyTaskEvent(tasks, completed({ task_id: 'fresh', ts: 95 }))
    pruneFinishedBefore(tasks, 50)
    expect(Object.keys(tasks).sort()).toEqual(['ancient-running', 'fresh'])
  })
})

describe('laneCountFromTasks', () => {
  it('returns the floor when no slot exceeds it', () => {
    const tasks: Record<string, TaskView> = {}
    applyTaskEvent(tasks, started({ slot: 3 }))
    expect(laneCountFromTasks(Object.values(tasks), 4)).toBe(4)
  })

  it('grows to fit the highest slot seen', () => {
    const tasks: Record<string, TaskView> = {}
    applyTaskEvent(tasks, started({ slot: 11 }))
    expect(laneCountFromTasks(Object.values(tasks), 4)).toBe(12)
  })

  it('returns the floor with no tasks at all', () => {
    expect(laneCountFromTasks([], 4)).toBe(4)
  })
})

describe('run timing (v1.29)', () => {
  it('reads run_started_at, exit_notice_ms and reported_run_seconds from completion metadata', () => {
    const tasks: Record<string, TaskView> = {}
    applyTaskEvent(tasks, started())
    applyTaskEvent(
      tasks,
      completed({
        metadata: JSON.stringify({
          run_started_at: 100.0001,
          exit_notice_ms: 812.5,
          reported_run_seconds: 2.5,
        }),
      }),
    )
    const t = tasks['t1']
    expect(t.run_started_at).toBe(100.0001)
    expect(t.exit_notice_ms).toBe(812.5)
    expect(t.reported_run_seconds).toBe(2.5)
  })

  it('reads them from task_failed too', () => {
    const tasks: Record<string, TaskView> = {}
    applyTaskEvent(tasks, started())
    applyTaskEvent(tasks, {
      event: 'task_failed',
      ts: 105,
      task_id: 't1',
      duration: 4,
      metadata: JSON.stringify({ run_started_at: 100, exit_notice_ms: 1.5 }),
    })
    expect(tasks['t1'].run_started_at).toBe(100)
    expect(tasks['t1'].exit_notice_ms).toBe(1.5)
    expect(tasks['t1'].reported_run_seconds).toBeNull()
  })

  it('leaves them null for an older backend', () => {
    const tasks: Record<string, TaskView> = {}
    applyTaskEvent(tasks, started())
    applyTaskEvent(tasks, completed({ metadata: JSON.stringify({ spawn_ms: 1 }) }))
    expect(tasks['t1'].run_started_at).toBeNull()
    expect(tasks['t1'].exit_notice_ms).toBeNull()
    expect(tasks['t1'].reported_run_seconds).toBeNull()
  })

  it('takes the row keys on resync and keeps the WS-only exit notice', () => {
    const tasks: Record<string, TaskView> = {}
    applyTaskEvent(tasks, started())
    applyTaskEvent(
      tasks,
      completed({ metadata: JSON.stringify({ run_started_at: 100, exit_notice_ms: 70 }) }),
    )
    const row: RecentTask = {
      task_id: 't1',
      partition: 0,
      start_ts: 100,
      end_ts: 105,
      duration: 5,
      status: 'completed',
      args: null,
      pid: null,
      slot: 2,
      labels: null,
      env: null,
      origin: 'kafka',
      client_name: null,
      request_id: null,
      run_started_at: 100.5,
      reported_run_seconds: 1.25,
    }
    const merged = mergeRecentTasks(tasks, [row])
    expect(merged['t1'].run_started_at).toBe(100.5)
    expect(merged['t1'].reported_run_seconds).toBe(1.25)
    expect(merged['t1'].exit_notice_ms).toBe(70)
    // An older backend's row (no keys) keeps the WS-delivered values.
    const older = mergeRecentTasks(merged, [
      { ...row, run_started_at: undefined, reported_run_seconds: undefined },
    ])
    expect(older['t1'].run_started_at).toBe(100.5)
    expect(older['t1'].reported_run_seconds).toBe(1.25)
  })

  it('keeps the retry archive key on start_ts', () => {
    const tasks: Record<string, TaskView> = {}
    applyTaskEvent(tasks, started({ ts: 100 }))
    applyTaskEvent(
      tasks,
      completed({ ts: 103, metadata: JSON.stringify({ run_started_at: 99.5 }) }),
    )
    applyTaskEvent(tasks, started({ ts: 110 }))
    expect(Object.keys(tasks).sort()).toEqual(['t1', 't1:r100'])
    expect(tasks['t1:r100'].run_started_at).toBe(99.5)
  })
})

describe('queue_wait_ms', () => {
  it('parses queue_wait_ms from task_started metadata and survives completion', () => {
    const tasks: Record<string, TaskView> = {}
    applyTaskEvent(tasks, started({ metadata: JSON.stringify({ queue_wait_ms: 42.5 }) }))
    expect(tasks['t1'].queue_wait_ms).toBe(42.5)
    applyTaskEvent(tasks, completed())
    expect(tasks['t1'].queue_wait_ms).toBe(42.5)
  })
})
