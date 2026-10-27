// The coverage bar of the Databases tab (design 2.3, section E): one lane per
// source, each with the time spans that source covers, built from the answer
// the tab already has. A source the answer does not mention has no lane.

import type { DatabasesResponse, HistoryFile, OwnDb, PostgresPartitions } from './types'

export type LaneKey = 'memory' | 'live' | 'backlog' | 'sealed' | 'archive' | 'postgres'

export interface CoverageSpan {
  /** Epoch seconds. */
  from: number
  to: number
  label: string
}

export interface CoverageLane {
  key: LaneKey
  label: string
  spans: CoverageSpan[]
}

export interface Coverage {
  lanes: CoverageLane[]
  /** The axis, in epoch seconds; null with no span at all. */
  axis: { from: number; to: number } | null
}

const LANE_ORDER: { key: LaneKey; label: string }[] = [
  { key: 'memory', label: 'Memory' },
  { key: 'live', label: 'Live file' },
  { key: 'backlog', label: 'Backlog' },
  { key: 'sealed', label: 'Sealed' },
  { key: 'archive', label: 'Archives' },
  { key: 'postgres', label: 'Postgres' },
]

const ARCHIVE_NAME_RE =
  /(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})__(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})\.db\.gz$/

/** The window an archive covers, from the bounds in its name (UTC), or null for another name. */
export function archiveWindow(name: string): { from: number; to: number } | null {
  const m = ARCHIVE_NAME_RE.exec(name)
  if (!m) return null
  const from = Date.parse(`${m[1]}T${m[2]}:${m[3]}:00Z`)
  const to = Date.parse(`${m[4]}T${m[5]}:${m[6]}:00Z`)
  return Number.isNaN(from) || Number.isNaN(to) ? null : { from: from / 1000, to: to / 1000 }
}

function ownSpan(row: OwnDb): CoverageSpan | null {
  if (row.first_event_ts === null || row.last_event_ts === null) return null
  return { from: row.first_event_ts, to: row.last_event_ts, label: row.filename }
}

function metaSpan(file: HistoryFile): CoverageSpan | null {
  const first = file.meta?.first_event_ts
  const last = file.meta?.last_event_ts
  if (!first || !last) return null
  return { from: Date.parse(first) / 1000, to: Date.parse(last) / 1000, label: file.name }
}

function archiveSpan(file: HistoryFile): CoverageSpan | null {
  const window = archiveWindow(file.name)
  return window ? { ...window, label: file.name } : null
}

function present<T>(items: (T | null)[]): T[] {
  return items.filter((i): i is T => i !== null)
}

/**
 * The lanes of one worker. `own` are its own rows (the memory store, the live
 * file, backlog files); the sealed lane keeps the history files of `worker`
 * (every file when the name is unknown); archives cover several workers, so
 * all of the folder's archives show. `partitions` is the answer of the
 * Postgres read; without it there is no Postgres lane.
 */
export function buildCoverage(
  own: OwnDb[],
  data: Pick<DatabasesResponse, 'history'>,
  worker: string,
  partitions?: PostgresPartitions | null,
): Coverage {
  const files = data.history.folders.flatMap((f) => f.files)
  const byKey: Record<LaneKey, CoverageSpan[] | null> = {
    memory: spansOfKind(own, 'memory'),
    live: spansOfKind(own, 'live'),
    backlog: spansOfKind(own, 'backlog'),
    sealed: files.some((f) => f.kind === 'sealed')
      ? present(
          files
            .filter((f) => f.kind === 'sealed' && (!worker || f.meta?.worker === worker))
            .map(metaSpan),
        )
      : null,
    archive: files.some((f) => f.kind === 'archive')
      ? present(files.filter((f) => f.kind === 'archive').map(archiveSpan))
      : null,
    postgres: partitions
      ? partitions.partitions.map((p) => ({ from: p.from_ts, to: p.to_ts, label: p.name }))
      : null,
  }
  const lanes = LANE_ORDER.flatMap(({ key, label }) => {
    const spans = byKey[key]
    return spans === null ? [] : [{ key, label, spans }]
  })
  const all = lanes.flatMap((l) => l.spans)
  const axis =
    all.length === 0
      ? null
      : { from: Math.min(...all.map((s) => s.from)), to: Math.max(...all.map((s) => s.to)) }
  return { lanes, axis }
}

// The lane of a kind exists when the worker lists a row of it.
function spansOfKind(own: OwnDb[], kind: string): CoverageSpan[] | null {
  const rows = own.filter((o) => o.kind === kind)
  return rows.length === 0 ? null : present(rows.map(ownSpan))
}

/** Position of a span on the axis in percent; a span narrower than `minWidth` percent is widened so it stays visible. */
export function spanPosition(
  span: Pick<CoverageSpan, 'from' | 'to'>,
  axis: { from: number; to: number },
  minWidth = 0.5,
): { left: number; width: number } {
  const total = Math.max(axis.to - axis.from, 1)
  const left = Math.max(Math.min(((span.from - axis.from) / total) * 100, 100 - minWidth), 0)
  const width = Math.min(Math.max(((span.to - span.from) / total) * 100, minWidth), 100 - left)
  return { left, width }
}

/** The epoch second under a fraction (0 to 1) of the axis. */
export function timeAtFraction(axis: { from: number; to: number }, fraction: number): number {
  const clamped = Math.min(Math.max(fraction, 0), 1)
  return Math.round(axis.from + clamped * (axis.to - axis.from))
}

/** The range a drag between two fractions selects, ordered; null when it is too short to mean a range. */
export function dragRange(
  axis: { from: number; to: number },
  a: number,
  b: number,
): { from: number; to: number } | null {
  const from = timeAtFraction(axis, Math.min(a, b))
  const to = timeAtFraction(axis, Math.max(a, b))
  return to > from ? { from, to } : null
}

/** The overall extent of a lane, or null for a lane with no span. */
export function laneExtent(lane: CoverageLane): { from: number; to: number } | null {
  if (lane.spans.length === 0) return null
  return {
    from: Math.min(...lane.spans.map((s) => s.from)),
    to: Math.max(...lane.spans.map((s) => s.to)),
  }
}

/** One line for the Slice view: what each source covers, `format` turning epoch seconds into text. */
export function coverageSummary(
  coverage: Coverage,
  format: (epochSeconds: number) => string,
): string {
  const parts = coverage.lanes.map((lane) => {
    const extent = laneExtent(lane)
    if (lane.key === 'sealed') return `sealed files ${lane.spans.length}`
    if (lane.key === 'archive') return `archives ${lane.spans.length} (not read by a slice)`
    if (lane.key === 'postgres') return `postgres partitions ${lane.spans.length}`
    const name = lane.key === 'memory' ? 'memory' : lane.label.toLowerCase()
    return extent
      ? `${name} covers ${format(extent.from)} to ${format(extent.to)}`
      : `${name} is empty`
  })
  return parts.length ? parts.join('; ') : 'no source reports a time range'
}
