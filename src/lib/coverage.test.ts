import { describe, expect, it } from 'vitest'
import { archiveWindow, buildCoverage, coverageSummary, dragRange, spanPosition } from './coverage'
import type { HistoryFile, OwnDb, PostgresPartitions } from './types'

function own(kind: string, first: number | null, last: number | null): OwnDb {
  return {
    filename: `w-1-${kind}`,
    worker_name: 'w-1',
    cluster_name: 'search',
    kind,
    event_count: 1,
    event_counts: {},
    first_event_ts: first,
    last_event_ts: last,
    size_bytes: 1,
  }
}

function sealed(worker: string, first: string, last: string): HistoryFile {
  return {
    path: `history/search/${worker}.db`,
    name: `${worker}-2026-10-14__07_00_00.db`,
    kind: 'sealed',
    size_bytes: 1,
    modified_at: last,
    meta: {
      schema: 1,
      worker,
      cluster: 'search',
      first_event_ts: first,
      last_event_ts: last,
      sealed_at: last,
      size_bytes: 1,
      tables: {},
      event_types: {},
    },
  }
}

const archive: HistoryFile = {
  path: 'history/search/search-2026-10-12_00-00__2026-10-13_00-00.db.gz',
  name: 'search-2026-10-12_00-00__2026-10-13_00-00.db.gz',
  kind: 'archive',
  size_bytes: 1,
  modified_at: '2026-10-13T02:00:00.000000Z',
  meta: null,
}

const history = (files: HistoryFile[]) => ({
  history: { folders: [{ folder: 'history/search', kind: 'history', cluster: 'search', files }] },
})

describe('coverage lanes', () => {
  it('draws one lane per source in a fixed order, with the spans of its rows', () => {
    const coverage = buildCoverage(
      [own('live', 200, 300), own('memory', 290, 300), own('backlog', 100, 200)],
      history([sealed('w-1', '2026-10-14T07:00:00Z', '2026-10-14T08:00:00Z'), archive]),
      'w-1',
    )
    expect(coverage.lanes.map((l) => l.key)).toEqual([
      'memory',
      'live',
      'backlog',
      'sealed',
      'archive',
    ])
    expect(coverage.lanes[0].spans).toEqual([{ from: 290, to: 300, label: 'w-1-memory' }])
    expect(coverage.axis).toEqual({ from: 100, to: Date.UTC(2026, 9, 14, 8) / 1000 })
  })

  it('reads the window of an archive from its name, in UTC', () => {
    expect(archiveWindow(archive.name)).toEqual({
      from: Date.UTC(2026, 9, 12) / 1000,
      to: Date.UTC(2026, 9, 13) / 1000,
    })
    expect(archiveWindow('merged-2026-10-14__10_00_00-ab.db')).toBeNull()
  })

  it('makes no lane for a source the answer does not mention', () => {
    const coverage = buildCoverage([own('live', 1, 2)], history([]), 'w-1')
    expect(coverage.lanes.map((l) => l.key)).toEqual(['live'])
    expect(buildCoverage([], history([]), 'w-1')).toEqual({ lanes: [], axis: null })
  })

  it('keeps only the sealed files of the chosen worker', () => {
    const files = [
      sealed('w-1', '2026-10-14T07:00:00Z', '2026-10-14T08:00:00Z'),
      sealed('w-2', '2026-10-14T07:00:00Z', '2026-10-14T08:00:00Z'),
    ]
    const lane = buildCoverage([], history(files), 'w-2').lanes[0]
    expect(lane.spans.map((s) => s.label)).toEqual(['w-2-2026-10-14__07_00_00.db'])
  })

  it('adds a Postgres lane only when the partitions were read', () => {
    const partitions = {
      partitions: [{ name: 'p1', from_ts: 3600, to_ts: 7200, size_bytes: null }],
    } as PostgresPartitions
    expect(buildCoverage([], history([]), 'w-1').lanes).toEqual([])
    expect(buildCoverage([], history([]), 'w-1', partitions).lanes[0]).toEqual({
      key: 'postgres',
      label: 'Postgres',
      spans: [{ from: 3600, to: 7200, label: 'p1' }],
    })
  })
})

describe('coverage bar geometry and summary', () => {
  const axis = { from: 1000, to: 2000 }

  it('places a span in percent of the axis and keeps a tiny span visible', () => {
    expect(spanPosition({ from: 1250, to: 1750 }, axis)).toEqual({ left: 25, width: 50 })
    expect(spanPosition({ from: 1500, to: 1500 }, axis).width).toBe(0.5)
  })

  it('turns a drag into an ordered range and ignores a click', () => {
    expect(dragRange(axis, 0.75, 0.25)).toEqual({ from: 1250, to: 1750 })
    expect(dragRange(axis, 0.5, 0.5)).toBeNull()
  })

  it('writes one line of what each source covers', () => {
    const coverage = buildCoverage(
      [own('memory', 10, 20), own('live', 5, 20)],
      history([sealed('w-1', '2026-10-14T07:00:00Z', '2026-10-14T08:00:00Z'), archive]),
      'w-1',
    )
    expect(coverageSummary(coverage, (ts) => `t${ts}`)).toBe(
      'memory covers t10 to t20; live file covers t5 to t20; sealed files 1; archives 1 (not read by a slice)',
    )
  })
})
