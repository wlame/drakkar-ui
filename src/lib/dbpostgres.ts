// Text of the Postgres view of the Databases tab, from the `recorder.postgres`
// block of GET /api/v1/debug/databases (the table and this worker's writer)
// and from GET /api/v1/debug/databases/postgres (the partitions). Pure: the
// clock formatter is a parameter, so tests do not depend on the browser's
// locale or time zone.

import { fmtBytes } from './format'
import { fmtSpan, type ClockFormatter } from './dbmode'
import type { PostgresPartitions, PostgresStatus } from './types'

const SECONDS_PER_HOUR = 3600

/** Why the next upkeep drops a partition, or null when it keeps it. */
export type PartitionDrop = 'retention' | 'size' | null

export interface PartitionView {
  name: string
  /** The hour the partition holds, as clock times: `08:00 – 09:00`. */
  hours: string
  sizeBytes: number | null
  drop: PartitionDrop
}

/** One view row per partition, oldest first, marked with the drop of the next upkeep. */
export function partitionViews(answer: PostgresPartitions, clock: ClockFormatter): PartitionView[] {
  const byRetention = new Set(answer.next_drops.retention)
  const bySize = new Set(answer.next_drops.size)
  return answer.partitions.map((p) => ({
    name: p.name,
    hours: `${clock(p.from_ts)} – ${clock(p.to_ts)}`,
    sizeBytes: p.size_bytes,
    drop: byRetention.has(p.name) ? 'retention' : bySize.has(p.name) ? 'size' : null,
  }))
}

/** The retention line: the value the upkeep uses (stored in the table) against this worker's setting. */
export function retentionNote(stored: number | null, initialHours: number | null): string {
  if (stored === null) {
    return 'The table stores no retention: the upkeep drops no partition by age.'
  }
  const kept = `The upkeep keeps ${fmtSpan(stored * SECONDS_PER_HOUR)} of history (stored in the table).`
  if (initialHours === null || initialHours === stored) return kept
  return `${kept} This worker's initial_retention is ${fmtSpan(initialHours * SECONDS_PER_HOUR)}; it applies only to a new table.`
}

/** The size line: the total of the partitions against this worker's max_size. */
export function sizeNote(totalBytes: number, maxSizeBytes: number | null): string {
  if (!maxSizeBytes) return `Total ${fmtBytes(totalBytes)} (no size cap).`
  return `Total ${fmtBytes(totalBytes)} of a cap of ${fmtBytes(maxSizeBytes)}.`
}

/** The writer line of this worker: queue, rows written and rows dropped. */
export function writerNote(writer: PostgresStatus['writer']): string {
  if (writer === null)
    return 'This worker writes no rows (capture off, or the recorder has not started).'
  if (!writer.started) return 'The writer has not reached the table yet.'
  const dropped = Object.values(writer.dropped).reduce((sum, n) => sum + n, 0)
  const parts = [
    `${writer.rows_written.toLocaleString()} rows written`,
    `${writer.queue_rows.toLocaleString()} waiting (${fmtBytes(writer.queue_bytes)})`,
    `${dropped.toLocaleString()} dropped`,
  ]
  if (writer.breaker_open) parts.push('breaker open')
  return parts.join(' · ')
}

/** The drops of the writer by reason, only the reasons with rows. */
export function droppedReasons(writer: PostgresStatus['writer']): string[] {
  if (writer === null) return []
  return Object.entries(writer.dropped)
    .filter(([, n]) => n > 0)
    .map(([reason, n]) => `${reason}: ${n.toLocaleString()}`)
}

/** The last upkeep of this worker, in one line. */
export function upkeepNote(writer: PostgresStatus['writer'], clock: ClockFormatter): string {
  const upkeep = writer?.last_upkeep
  if (!upkeep) return 'No upkeep yet.'
  const at = clock(Date.parse(upkeep.at) / 1000)
  if (!upkeep.held_lock) return `Last upkeep at ${at}: another worker held the upkeep lock.`
  const changes = [
    upkeep.created.length ? `created ${upkeep.created.length}` : '',
    upkeep.dropped.length ? `dropped ${upkeep.dropped.length} by retention` : '',
    upkeep.dropped_for_size.length ? `dropped ${upkeep.dropped_for_size.length} for size` : '',
  ].filter(Boolean)
  return `Last upkeep at ${at}: ${changes.length ? changes.join(', ') : 'no change'}.`
}
