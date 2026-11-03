import { describe, expect, it } from 'vitest'
import {
  droppedReasons,
  partitionViews,
  retentionNote,
  sizeNote,
  upkeepNote,
  writerNote,
} from './dbpostgres'
import type { PostgresPartitions, PostgresStatus } from './types'

const clock = (epoch: number) => new Date(epoch * 1000).toISOString().slice(11, 16)

type Writer = NonNullable<PostgresStatus['writer']>
const writer: Writer = {
  started: true,
  queue_rows: 0,
  queue_bytes: 0,
  rows_written: 10,
  dropped: { queue_full: 1, rejected: 0, no_partition: 0, shutdown: 0 },
  breaker_open: true,
  last_upkeep: null,
}

describe('dbpostgres', () => {
  it('marks each partition with the drop of the next upkeep, retention first', () => {
    const answer: PostgresPartitions = {
      server_now: 0,
      stored_retention_hours: 1,
      partitions: [
        { name: 'a', from_ts: 0, to_ts: 3600, size_bytes: 1 },
        { name: 'b', from_ts: 3600, to_ts: 7200, size_bytes: 2 },
        { name: 'c', from_ts: 7200, to_ts: 10800, size_bytes: null },
      ],
      total_bytes: 3,
      next_drops: { retention: ['a'], size: ['a', 'b'] },
    }

    expect(partitionViews(answer, clock)).toEqual([
      { name: 'a', hours: '00:00 – 01:00', sizeBytes: 1, drop: 'retention' },
      { name: 'b', hours: '01:00 – 02:00', sizeBytes: 2, drop: 'size' },
      { name: 'c', hours: '02:00 – 03:00', sizeBytes: null, drop: null },
    ])
  })

  it('says which retention the upkeep uses', () => {
    expect(retentionNote(null, 6)).toBe(
      'The table stores no retention: the upkeep drops no partition by age.',
    )
    expect(retentionNote(6, 6)).toBe('The upkeep keeps 6h of history (stored in the table).')
    expect(retentionNote(6, null)).toBe('The upkeep keeps 6h of history (stored in the table).')
    expect(retentionNote(48, 6)).toBe(
      "The upkeep keeps 48h of history (stored in the table). This worker's initial_retention is 6h; it applies only to a new table.",
    )
  })

  it('says the total against the size cap', () => {
    expect(sizeNote(2048, 0)).toBe('Total 2.0 KB (no size cap).')
    expect(sizeNote(2048, 4096)).toBe('Total 2.0 KB of a cap of 4.0 KB.')
  })

  it('describes the writer in every state', () => {
    expect(writerNote(null)).toContain('writes no rows')
    expect(writerNote({ ...writer, started: false })).toBe(
      'The writer has not reached the table yet.',
    )
    expect(writerNote(writer)).toBe('10 rows written · 0 waiting (0 B) · 1 dropped · breaker open')
    expect(droppedReasons(writer)).toEqual(['queue_full: 1'])
    expect(droppedReasons(null)).toEqual([])
  })

  it('describes the last upkeep', () => {
    expect(upkeepNote(writer, clock)).toBe('No upkeep yet.')
    const upkeep = (extra: Partial<NonNullable<Writer['last_upkeep']>>) => ({
      ...writer,
      last_upkeep: {
        at: '2026-11-08T10:05:00.000000Z',
        held_lock: true,
        created: [],
        dropped: [],
        dropped_for_size: [],
        ...extra,
      },
    })
    expect(upkeepNote(upkeep({ held_lock: false }), clock)).toBe(
      'Last upkeep at 10:05: another worker held the upkeep lock.',
    )
    expect(upkeepNote(upkeep({}), clock)).toBe('Last upkeep at 10:05: no change.')
    expect(
      upkeepNote(upkeep({ created: ['x'], dropped: ['y'], dropped_for_size: ['z', 'w'] }), clock),
    ).toBe('Last upkeep at 10:05: created 1, dropped 1 by retention, dropped 2 for size.')
  })
})
