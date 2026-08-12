import { describe, it, expect } from 'vitest'
import {
  arrangeFromEvent,
  baseTaskId,
  taskFromRecent,
  normalizeRecentTasks,
  annotationFromEvent,
  annotationsForArrange,
  netFromEvent,
  type AnnotationView,
} from './live'
import type { RecentTask, WsEvent } from './types'

describe('baseTaskId', () => {
  it('strips a :r<ts> retry suffix', () => {
    expect(baseTaskId('p1-42:r1719878400')).toBe('p1-42')
  })

  it('leaves ids without a retry suffix alone', () => {
    expect(baseTaskId('p1-42')).toBe('p1-42')
  })

  it('always returns the segment before the FIRST retry marker', () => {
    expect(baseTaskId('a:r1:r2')).toBe('a')
  })
})

describe('taskFromRecent', () => {
  const recent: RecentTask = {
    task_id: 'p0-7',
    partition: 0,
    start_ts: 100,
    end_ts: 105,
    duration: 5,
    status: 'completed',
    args: '["run"]',
    pid: 4242,
    slot: 2,
    labels: { app: 'x' },
    env: { K: 'v' },
    origin: 'kafka',
    client_name: null,
    request_id: null,
  }

  it('copies the resync fields through', () => {
    const t = taskFromRecent(recent)
    expect(t.task_id).toBe('p0-7')
    expect(t.partition).toBe(0)
    expect(t.status).toBe('completed')
    expect(t.duration).toBe(5)
    expect(t.labels).toEqual({ app: 'x' })
    expect(t.env).toEqual({ K: 'v' })
  })

  it('leaves WS-only fields null (the resync payload does not carry them)', () => {
    const t = taskFromRecent(recent)
    expect(t.exit_code).toBeNull()
    expect(t.stdout_lines).toBeNull()
    expect(t.stdin_lines).toBeNull()
    expect(t.stdin_size).toBeNull()
    expect(t.source_offsets).toBeNull()
  })

  // stdout_size is NOT WS-only: the resync row carries it (v1.7), which is
  // what makes stdout_size color rules work for tasks that finished before
  // the page connected.
  it('forwards a stdout_size present on the resync row', () => {
    expect(taskFromRecent({ ...recent, stdout_size: 4096 }).stdout_size).toBe(4096)
    expect(taskFromRecent({ ...recent, stdout_size: 0 }).stdout_size).toBe(0)
  })

  it('leaves stdout_size null when the row omits it (pre-v1.7 backend)', () => {
    expect(taskFromRecent(recent).stdout_size).toBeNull()
    expect(taskFromRecent({ ...recent, stdout_size: null }).stdout_size).toBeNull()
  })
})

describe('normalizeRecentTasks', () => {
  const row: RecentTask = {
    task_id: 'p0-1',
    partition: 0,
    start_ts: 1,
    end_ts: 2,
    duration: 1,
    status: 'completed',
    args: null,
    pid: null,
    slot: null,
    labels: null,
    env: null,
    origin: 'kafka',
    client_name: null,
    request_id: null,
  }

  it('passes a well-formed payload through untouched', () => {
    const n = normalizeRecentTasks({ tasks: [row], lane_count: 12, truncated: false })
    expect(n.unavailable).toBe(false)
    expect(n.tasks).toEqual([row])
    expect(n.lane_count).toBe(12)
    expect(n.truncated).toBe(false)
  })

  it('keeps a truncated flag on an otherwise good payload', () => {
    expect(normalizeRecentTasks({ tasks: [], lane_count: 8, truncated: true })).toEqual({
      tasks: [],
      lane_count: 8,
      truncated: true,
      unavailable: false,
    })
  })

  it('flags a payload the backend marked unavailable', () => {
    const n = normalizeRecentTasks({
      tasks: [],
      lane_count: 16,
      truncated: false,
      unavailable: true,
    })
    expect(n.unavailable).toBe(true)
    expect(n.tasks).toEqual([])
    // The placeholder still reports a real lane count, so it is worth keeping.
    expect(n.lane_count).toBe(16)
  })

  // An unavailable payload is a placeholder, never a measurement — even if
  // some backend were to send rows alongside the flag, they are not data.
  it('discards tasks that arrive with the unavailable flag set', () => {
    const n = normalizeRecentTasks({ tasks: [row], lane_count: 8, unavailable: true })
    expect(n.unavailable).toBe(true)
    expect(n.tasks).toEqual([])
  })

  // The bug this guard exists for: a degraded backend that predates the
  // `unavailable` flag answers with a bare array, which used to be iterated
  // as `payload.tasks` and throw.
  it('treats a bare array as unavailable rather than as zero tasks', () => {
    expect(normalizeRecentTasks([])).toEqual({
      tasks: [],
      lane_count: null,
      truncated: false,
      unavailable: true,
    })
    expect(normalizeRecentTasks([row]).unavailable).toBe(true)
  })

  it('treats an object without a tasks array as unavailable', () => {
    expect(normalizeRecentTasks({ lane_count: 8 })).toEqual({
      tasks: [],
      lane_count: 8,
      truncated: false,
      unavailable: true,
    })
    expect(normalizeRecentTasks({ tasks: null, lane_count: 8 }).unavailable).toBe(true)
    expect(normalizeRecentTasks({ tasks: 'nope' }).unavailable).toBe(true)
  })

  it.each([[null], [undefined], ['[]'], [42]])('treats %p as unavailable', (payload) => {
    const n = normalizeRecentTasks(payload)
    expect(n.unavailable).toBe(true)
    expect(n.tasks).toEqual([])
    expect(n.lane_count).toBeNull()
  })

  // laneCount on the page has its own fallback; a missing or nonsensical lane
  // count must leave it alone rather than collapse the timeline to zero lanes.
  it('reports no lane count when the payload carries none it can use', () => {
    expect(normalizeRecentTasks({ tasks: [] }).lane_count).toBeNull()
    expect(normalizeRecentTasks({ tasks: [], lane_count: 0 }).lane_count).toBeNull()
    expect(normalizeRecentTasks({ tasks: [], lane_count: '8' }).lane_count).toBeNull()
  })
})

describe('arrangeFromEvent', () => {
  const base: WsEvent = { event: 'arranged', ts: 1000 }

  it('parses offsets, task_ids and message_labels out of the metadata JSON', () => {
    const a = arrangeFromEvent({
      ...base,
      partition: 3,
      duration: 0.25,
      metadata: JSON.stringify({
        offsets: [10, 11],
        task_ids: ['t1', 't2', 't3'],
        message_labels: ['lbl'],
      }),
    })
    expect(a.offsets).toEqual([10, 11])
    expect(a.task_ids).toEqual(['t1', 't2', 't3'])
    expect(a.message_labels).toEqual(['lbl'])
    expect(a.partition).toBe(3)
    expect(a.duration).toBe(0.25)
  })

  it('derives counts from the metadata arrays when the frame has none', () => {
    const a = arrangeFromEvent({
      ...base,
      metadata: JSON.stringify({ offsets: [10, 11], task_ids: ['t1'] }),
    })
    expect(a.message_count).toBe(2)
    expect(a.task_count).toBe(1)
  })

  it('prefers explicit frame counts over derived ones', () => {
    const a = arrangeFromEvent({
      ...base,
      message_count: 5,
      task_count: 7,
      metadata: JSON.stringify({ offsets: [10], task_ids: ['t1'] }),
    })
    expect(a.message_count).toBe(5)
    expect(a.task_count).toBe(7)
  })

  it('metadata labels override the frame-level message_labels', () => {
    const a = arrangeFromEvent({
      ...base,
      message_labels: ['frame'],
      metadata: JSON.stringify({ message_labels: ['meta'] }),
    })
    expect(a.message_labels).toEqual(['meta'])
  })

  it('keeps frame-level message_labels when metadata has none', () => {
    const a = arrangeFromEvent({ ...base, message_labels: ['frame'], metadata: '{}' })
    expect(a.message_labels).toEqual(['frame'])
  })

  it('survives malformed metadata with safe defaults', () => {
    const a = arrangeFromEvent({ ...base, metadata: '{not json' })
    expect(a.offsets).toEqual([])
    expect(a.task_ids).toEqual([])
    expect(a.message_labels).toEqual([])
    expect(a.message_count).toBe(0)
    expect(a.task_count).toBe(0)
  })

  it('ignores metadata fields of the wrong shape', () => {
    const a = arrangeFromEvent({
      ...base,
      metadata: JSON.stringify({ offsets: 'nope', task_ids: 42 }),
    })
    expect(a.offsets).toEqual([])
    expect(a.task_ids).toEqual([])
  })

  it('defaults partition to -1 and duration to 0 when the frame omits them', () => {
    const a = arrangeFromEvent(base)
    expect(a.partition).toBe(-1)
    expect(a.duration).toBe(0)
    expect(a.ts).toBe(1000)
  })
})

describe('annotationFromEvent', () => {
  const frame = (over: Partial<WsEvent> = {}): WsEvent =>
    ({
      id: 1,
      ts: 100,
      event: 'annotation',
      partition: 3,
      metadata: JSON.stringify({
        kind: 'input_selection',
        scope: 'message',
        hook: 'arrange',
        window_id: 7,
        offsets: [],
        data: { a: 1 },
      }),
      ...over,
    }) as WsEvent

  it('flattens the envelope and the anchor columns', () => {
    const a = annotationFromEvent(frame({ offset: 90 }))
    expect(a).not.toBeNull()
    expect(a!.kind).toBe('input_selection')
    expect(a!.scope).toBe('message')
    expect(a!.hook).toBe('arrange')
    expect(a!.partition).toBe(3)
    expect(a!.offset).toBe(90)
    expect(a!.task_id).toBeNull()
    expect(a!.data).toEqual({ a: 1 })
  })

  it('returns null for a frame that is not an annotation', () => {
    expect(annotationFromEvent(frame({ event: 'task_started' }))).toBeNull()
  })

  it('returns null for a malformed envelope', () => {
    expect(annotationFromEvent(frame({ metadata: 'not json' }))).toBeNull()
  })
})

describe('annotationsForArrange', () => {
  const arrange = {
    ts: 0,
    partition: 3,
    duration: 0,
    message_count: 2,
    task_count: 1,
    task_ids: ['t-1'],
    offsets: [90, 91],
    message_labels: [],
    window_id: 7,
  }
  const ann = (over: Partial<AnnotationView>): AnnotationView => ({
    ts: 0,
    partition: 3,
    kind: 'k',
    scope: 'window',
    hook: 'arrange',
    window_id: 7,
    offset: null,
    task_id: null,
    data: {},
    ...over,
  })

  it('matches window scope on window_id', () => {
    expect(annotationsForArrange([ann({})], arrange)).toHaveLength(1)
  })

  it('matches message scope on the batch offsets', () => {
    const got = annotationsForArrange([ann({ scope: 'message', offset: 91 })], arrange)
    expect(got).toHaveLength(1)
  })

  it('matches task scope on the batch task ids', () => {
    const got = annotationsForArrange([ann({ scope: 'task', task_id: 't-1' })], arrange)
    expect(got).toHaveLength(1)
  })

  it('excludes another window, another offset, another task and another partition', () => {
    const others = [
      ann({ window_id: 8 }),
      ann({ scope: 'message', offset: 999 }),
      ann({ scope: 'task', task_id: 't-other' }),
      ann({ partition: 4 }),
    ]
    expect(annotationsForArrange(others, arrange)).toHaveLength(0)
  })

  it('excludes window rows when the backend omitted window_id', () => {
    // Older backends predate the arranged-metadata window_id; a null on either
    // side must not collapse into a match-everything.
    expect(annotationsForArrange([ann({ window_id: null })], arrange)).toHaveLength(0)
    expect(annotationsForArrange([ann({})], { ...arrange, window_id: null })).toHaveLength(0)
  })
})

describe('netFromEvent', () => {
  const frame = (metadata?: string): WsEvent => ({ event: 'net_io', ts: 1000, metadata })

  it('extracts the RX/TX rates', () => {
    const e = frame(JSON.stringify({ rx_mib_s: 12.5, tx_mib_s: 0.75, interval_s: 10 }))
    expect(netFromEvent(e)).toEqual({ rx_mib_s: 12.5, tx_mib_s: 0.75 })
  })

  it('returns null for other event types', () => {
    expect(netFromEvent({ event: 'task_started', ts: 1000 })).toBeNull()
  })

  it('returns null without metadata', () => {
    expect(netFromEvent(frame(undefined))).toBeNull()
  })

  it('returns null on malformed metadata JSON', () => {
    expect(netFromEvent(frame('not json'))).toBeNull()
  })

  it('returns null when a rate field is missing or not a number', () => {
    expect(netFromEvent(frame(JSON.stringify({ rx_mib_s: 1 })))).toBeNull()
    expect(netFromEvent(frame(JSON.stringify({ rx_mib_s: '1', tx_mib_s: 2 })))).toBeNull()
  })
})
