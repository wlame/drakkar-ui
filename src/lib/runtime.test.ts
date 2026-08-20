import { describe, expect, it, test } from 'vitest'
import {
  VERDICT_LABELS,
  aggregateStallSites,
  episodeFromMetadata,
  fmtLagMs,
  mergeStallSources,
  sparklinePoints,
  stallFromMetadata,
  windowPeakMs,
} from './runtime'
import type { RuntimeLagBucket } from './types'

const bucket = (t: number, max: number, avg = max): RuntimeLagBucket => ({
  t,
  max_lag_ms: max,
  avg_lag_ms: avg,
})

describe('sparklinePoints', () => {
  test('spreads buckets across the width and scales lag to height', () => {
    const points = sparklinePoints([bucket(1, 0), bucket(2, 100), bucket(3, 50)], 100, 50)
    expect(points).toBe('0,50 50,0 100,25')
  })

  test('floors the ceiling so healthy sub-ms noise stays flat', () => {
    // Peak 0.4ms with a 100ms floor: y stays within a pixel of the bottom.
    const points = sparklinePoints([bucket(1, 0.2), bucket(2, 0.4)], 100, 50)
    const ys = points.split(' ').map((p) => Number(p.split(',')[1]))
    expect(Math.min(...ys)).toBeGreaterThan(49)
  })

  test('degrades empty and single-bucket windows', () => {
    expect(sparklinePoints([], 100, 50)).toBe('')
    expect(sparklinePoints([bucket(1, 100)], 100, 50)).toBe('50,0')
  })
})

describe('windowPeakMs', () => {
  test('returns the max across buckets and 0 for empty', () => {
    expect(windowPeakMs([bucket(1, 3), bucket(2, 8), bucket(3, 5)])).toBe(8)
    expect(windowPeakMs([])).toBe(0)
  })
})

describe('fmtLagMs', () => {
  test('scales units with magnitude', () => {
    expect(fmtLagMs(0.42)).toBe('0.4 ms')
    expect(fmtLagMs(250)).toBe('250 ms')
    expect(fmtLagMs(12_500)).toBe('12.5 s')
  })
})

describe('stallFromMetadata', () => {
  test('parses a full payload', () => {
    const stall = stallFromMetadata(
      JSON.stringify({
        duration_ms: 1500,
        stacks: [{ stack: 'File "x.py"...', location: 'x.py:10', count: 3 }],
        dropped_stacks: 1,
        unit_count: 42,
      }),
    )
    expect(stall.duration_ms).toBe(1500)
    expect(stall.stacks).toHaveLength(1)
    expect(stall.dropped_stacks).toBe(1)
    expect(stall.unit_count).toBe(42)
  })

  test('degrades absent or malformed metadata to an empty stall', () => {
    for (const bad of [null, undefined, '', 'not json', '{"stacks": "oops"}']) {
      const stall = stallFromMetadata(bad)
      expect(stall.stacks).toEqual([])
      expect(stall.duration_ms).toBe(0)
      expect(stall.unit_count).toBe(-1)
    }
  })
})

describe('aggregateStallSites', () => {
  const stall = (
    ts: number,
    durationMs: number,
    stacks: { location: string; count: number; stack?: string }[],
  ) => ({
    ts,
    metadata: JSON.stringify({
      duration_ms: durationMs,
      stacks: stacks.map((s) => ({
        stack: s.stack ?? 'trace',
        location: s.location,
        count: s.count,
      })),
      dropped_stacks: 0,
      unit_count: 1,
    }),
  })

  it('groups sites across stalls, busiest first', () => {
    const sites = aggregateStallSites([
      stall(100, 2000, [{ location: 'a.py:1', count: 3 }]),
      stall(200, 1000, [
        { location: 'a.py:1', count: 5 },
        { location: 'b.py:9', count: 1 },
      ]),
    ])
    expect(sites.map((s) => s.location)).toEqual(['a.py:1', 'b.py:9'])
    expect(sites[0]).toMatchObject({ stalls: 2, samples: 8, totalMs: 3000, lastTs: 200 })
    expect(sites[1]).toMatchObject({ stalls: 1, samples: 1, totalMs: 1000 })
  })

  it('counts a stall once per site even when the site is captured twice', () => {
    const sites = aggregateStallSites([
      stall(100, 2000, [
        { location: 'a.py:1', count: 3 },
        { location: 'a.py:1', count: 2 },
      ]),
    ])
    expect(sites[0]).toMatchObject({ stalls: 1, samples: 5, totalMs: 2000 })
  })

  it('keeps the most recent stack as the example', () => {
    const sites = aggregateStallSites([
      stall(100, 500, [{ location: 'a.py:1', count: 1, stack: 'old' }]),
      stall(200, 500, [{ location: 'a.py:1', count: 1, stack: 'new' }]),
    ])
    expect(sites[0].exampleStack).toBe('new')
  })
})

describe('episodeFromMetadata', () => {
  it('parses a full episode payload', () => {
    const episode = episodeFromMetadata(
      JSON.stringify({
        duration_ms: 45200,
        peak_lag_ms: 1900,
        lag_sum_ms: 8000,
        cpu_ms: 210,
        cpu_ratio: 0.005,
        verdict: 'starved',
        stall_count: 3,
        sample_count: 40,
        stacks: [{ stack: 's', location: 'x.py:1', count: 40 }],
        dropped_stacks: 1,
        unit_count: 7000,
        cpu_throttled_ms: 4200,
      }),
    )
    expect(episode.verdict).toBe('starved')
    expect(episode.duration_ms).toBe(45200)
    expect(episode.cpu_ratio).toBe(0.005)
    expect(episode.cpu_throttled_ms).toBe(4200)
    expect(episode.stacks).toHaveLength(1)
  })

  it('degrades malformed metadata to an inconclusive empty episode', () => {
    const episode = episodeFromMetadata('not json')
    expect(episode.verdict).toBe('inconclusive')
    expect(episode.stacks).toEqual([])
    expect(episode.duration_ms).toBe(0)
  })

  it('maps unknown verdict strings to inconclusive', () => {
    expect(episodeFromMetadata(JSON.stringify({ verdict: 'exploded' })).verdict).toBe(
      'inconclusive',
    )
  })
})

describe('VERDICT_LABELS', () => {
  it('covers every verdict with a label and a hint', () => {
    for (const verdict of ['blocked', 'cpu_bound', 'starved', 'inconclusive'] as const) {
      expect(VERDICT_LABELS[verdict].label.length).toBeGreaterThan(0)
      expect(VERDICT_LABELS[verdict].hint.length).toBeGreaterThan(10)
    }
  })
})

describe('mergeStallSources', () => {
  const stallRow = {
    id: 1,
    ts: 1000,
    metadata: JSON.stringify({
      duration_ms: 2100,
      stacks: [{ stack: 's', location: 'x.py:1', count: 4 }],
      dropped_stacks: 0,
      unit_count: 33,
    }),
  }
  const episodeRow = {
    id: 2,
    ts: 2000,
    metadata: JSON.stringify({
      duration_ms: 60000,
      peak_lag_ms: 19400,
      lag_sum_ms: 100,
      verdict: 'starved',
      stall_count: 5,
      sample_count: 10,
      stacks: [],
      dropped_stacks: 0,
      unit_count: 7000,
    }),
  }
  const snapshot = {
    enabled: true,
    state: 'stalled' as const,
    unit_label: 'tasks',
    current_lag_ms: 0,
    heartbeat_age_ms: 0,
    window: [],
    recent_stalls: [
      { t: 1000.4, duration_ms: 2100, stack_count: 1, top_location: 'x.py:1' }, // dup of stallRow
      { t: 3000, duration_ms: 13200, stack_count: 2, top_location: 'y.py:9' }, // memory-only
    ],
    recent_episodes: [
      {
        t: 2000.9,
        duration_ms: 60000,
        verdict: 'starved' as const,
        peak_lag_ms: 19400,
        top_location: null,
      }, // dup
      {
        t: 4000,
        duration_ms: 5000,
        verdict: 'blocked' as const,
        peak_lag_ms: 900,
        top_location: 'z.py:2',
      },
    ],
  }

  it('merges all three sources, deduplicates, and sorts newest first', () => {
    const items = mergeStallSources([stallRow], [episodeRow], snapshot)
    expect(items.map((item) => item.t)).toEqual([4000, 3000, 2000, 1000])
    expect(items[0].kind).toBe('episode')
    expect(items[0].fromSnapshotOnly).toBe(true)
    expect(items[1].kind).toBe('stall')
    expect(items[1].fromSnapshotOnly).toBe(true)
    // Persisted rows win over their snapshot twins (they carry the stacks).
    expect(items[2].fromSnapshotOnly).toBe(false)
    expect(items[3].stacks).toHaveLength(1)
  })

  it('renders the incident shape: snapshot summaries with zero persisted rows', () => {
    const items = mergeStallSources([], [], snapshot)
    expect(items).toHaveLength(4)
    expect(items.every((item) => item.fromSnapshotOnly)).toBe(true)
  })

  it('handles a pre-v1.15 snapshot without episode fields', () => {
    const legacy = { ...snapshot, recent_episodes: undefined, recent_stalls: [] }
    const items = mergeStallSources([stallRow], [], legacy)
    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe('stall')
  })

  it('handles a null snapshot', () => {
    expect(mergeStallSources([], [episodeRow], null)).toHaveLength(1)
  })
})
