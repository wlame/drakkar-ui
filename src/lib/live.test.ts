import { describe, it, expect } from 'vitest'
import { arrangeFromEvent, baseTaskId, taskFromRecent } from './live'
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
