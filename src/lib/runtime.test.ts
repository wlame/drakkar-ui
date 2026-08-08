import { describe, expect, test } from 'vitest'
import { fmtLagMs, sparklinePoints, stallFromMetadata, windowPeakMs } from './runtime'
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
