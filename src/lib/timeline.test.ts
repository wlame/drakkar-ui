import { describe, it, expect } from 'vitest'
import {
  barGeometry,
  tickMarks,
  followScrollLeft,
  shouldRebase,
  rebase,
  RENDER_DELAY_SEC,
} from './timeline'

describe('barGeometry', () => {
  it('positions a bar relative to the origin', () => {
    const g = barGeometry(1000, 1005, 990, 8, 2)
    expect(g.left).toBe((1000 - 990) * 8)
    expect(g.width).toBe((1005 - 1000) * 8)
  })

  it('clamps left to 0 for a task that started before the origin', () => {
    const g = barGeometry(980, 1005, 990, 8, 2)
    expect(g.left).toBe(0)
    // Width still reflects only the portion after the origin.
    expect(g.width).toBe((1005 - 990) * 8)
  })

  it('clamps width to the minimum for a very short task', () => {
    const g = barGeometry(1000, 1000.01, 990, 8, 2)
    expect(g.width).toBe(2)
  })

  it('never returns a negative left even for a task far in the past', () => {
    const g = barGeometry(0, 5, 990, 8, 2)
    expect(g.left).toBe(0)
  })
})

describe('tickMarks', () => {
  it('picks a 30s interval by default', () => {
    const ticks = tickMarks(0, 90, 8, 0)
    expect(ticks.map((t) => t.ts)).toEqual([0, 30, 60, 90])
  })

  it('picks a 10s interval at >= 16 px/sec', () => {
    const ticks = tickMarks(0, 30, 16, 0)
    expect(ticks.map((t) => t.ts)).toEqual([0, 10, 20, 30])
  })

  it('picks a 5s interval at >= 32 px/sec', () => {
    const ticks = tickMarks(0, 15, 32, 0)
    expect(ticks.map((t) => t.ts)).toEqual([0, 5, 10, 15])
  })

  it('picks a 60s interval below 4 px/sec', () => {
    const ticks = tickMarks(0, 180, 3.9, 0)
    expect(ticks.map((t) => t.ts)).toEqual([0, 60, 120, 180])
  })

  it('picks a 120s interval below 1 px/sec', () => {
    const ticks = tickMarks(0, 360, 0.9, 0)
    expect(ticks.map((t) => t.ts)).toEqual([0, 120, 240, 360])
  })

  it('positions ticks relative to the origin', () => {
    const ticks = tickMarks(1000, 1090, 8, 990)
    // First tick at or after 1000 on a 30s grid is 1020.
    expect(ticks[0].ts).toBe(1020)
    expect(ticks[0].left).toBe((1020 - 990) * 8)
  })

  it('keeps the same left for the same tick timestamp across two different "now" values', () => {
    // Same origin, two different windows (simulating time having advanced) —
    // a tick timestamp present in both must land at the same pixel.
    const originTs = 990
    const early = tickMarks(1000, 1090, 8, originTs)
    const later = tickMarks(1000, 1300, 8, originTs)
    const sharedTs = 1020
    const earlyTick = early.find((t) => t.ts === sharedTs)
    const laterTick = later.find((t) => t.ts === sharedTs)
    expect(earlyTick).toBeDefined()
    expect(laterTick).toBeDefined()
    expect(earlyTick!.left).toBe(laterTick!.left)
  })
})

describe('followScrollLeft', () => {
  it('places renderNowTs at the viewport right edge', () => {
    const originTs = 1000
    const pxPerSec = 8
    const viewportWidth = 1200
    const renderNowTs = 1500
    const scrollLeft = followScrollLeft(renderNowTs, originTs, pxPerSec, viewportWidth)
    expect(scrollLeft).toBe((renderNowTs - originTs) * pxPerSec - viewportWidth)
    // Sanity: right edge of the viewport lands exactly on renderNowTs.
    expect(originTs + (scrollLeft + viewportWidth) / pxPerSec).toBe(renderNowTs)
  })

  it('never returns a negative scrollLeft', () => {
    const scrollLeft = followScrollLeft(1000, 1000, 8, 1200)
    expect(scrollLeft).toBe(0)
  })
})

describe('shouldRebase / rebase', () => {
  it('is false within twice the window', () => {
    expect(shouldRebase(1000 + 1199, 1000, 600)).toBe(false)
    expect(shouldRebase(1000 + 1200, 1000, 600)).toBe(false)
  })

  it('is true past twice the window', () => {
    expect(shouldRebase(1000 + 1201, 1000, 600)).toBe(true)
  })

  it('rebases the origin forward by exactly one window', () => {
    expect(rebase(1000, 600)).toBe(1600)
  })

  it('shifts every bar left by exactly windowSec * pxPerSec — the invariant that makes rebasing invisible', () => {
    const oldOrigin = 1000
    const windowSec = 600
    const pxPerSec = 8
    const newOrigin = rebase(oldOrigin, windowSec)
    // Restricted to timestamps at or after the new origin: below it, `left`
    // clamps to 0 on both sides, which is a real (and harmless) edge case but
    // not what this invariant is about — see the two clamping tests above.
    for (const ts of [newOrigin, 1999, 2500, 3000]) {
      const before = barGeometry(ts, ts, oldOrigin, pxPerSec, 0).left
      const after = barGeometry(ts, ts, newOrigin, pxPerSec, 0).left
      expect(after).toBeCloseTo(before - windowSec * pxPerSec, 10)
    }
  })
})

describe('RENDER_DELAY_SEC', () => {
  it('is a small positive constant', () => {
    expect(RENDER_DELAY_SEC).toBe(2)
  })
})
