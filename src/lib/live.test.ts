import { describe, it, expect } from 'vitest'
import {
  arrangeFromEvent,
  baseTaskId,
  taskFromRecent,
  annotationFromEvent,
  annotationsForArrange,
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
    expect(t.stdout_size).toBeNull()
    expect(t.stdin_lines).toBeNull()
    expect(t.stdin_size).toBeNull()
    expect(t.source_offsets).toBeNull()
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
