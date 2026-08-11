import { describe, it, expect } from 'vitest'
import {
  barGeometry,
  tickMarks,
  followScrollLeft,
  shouldRebase,
  rebase,
  RENDER_DELAY_SEC,
  barTexts,
  tagBoxWidth,
  tagLeftOffset,
  textColorFor,
  deriveMarkers,
  TAG_MAX_CHARS,
  CAPTION_MAX_CHARS,
  TAG_CHROME_PX,
  TAG_EDGE_MARGIN_PX,
  TEXT_PX_PER_CHAR,
} from './timeline'
import type { TaskView } from './live'

function task(overrides: Partial<TaskView> = {}): TaskView {
  return {
    task_id: 't1',
    partition: 0,
    start_ts: 1000,
    end_ts: 1005,
    duration: 5,
    status: 'completed',
    exit_code: 0,
    args: null,
    pid: null,
    slot: null,
    labels: null,
    origin: 'kafka',
    client_name: null,
    request_id: null,
    stdout_size: null,
    stdout_lines: null,
    stdin_lines: null,
    stdin_size: null,
    env: null,
    source_offsets: null,
    spawn_ms: null,
    ...overrides,
  }
}

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

describe('barTexts', () => {
  // tag "abcde" is 5 chars -> est = 30px; gate is width >= est + 10 = 40.
  it('shows the tag exactly at its width threshold', () => {
    expect(barTexts(40, 'abcde', undefined)).toEqual({ tag: 'abcde' })
  })

  it('hides the tag 1px below its width threshold', () => {
    expect(barTexts(39, 'abcde', undefined)).toEqual({})
  })

  // Same tag (est 30) + caption "wxyz" (4 chars -> est 24). Caption gate is
  // remaining = width - est(tag) - 12 >= est(caption), i.e. width >= 66.
  it('adds the caption once the tag fits and the remaining width covers it', () => {
    expect(barTexts(66, 'abcde', 'wxyz')).toEqual({ tag: 'abcde', caption: 'wxyz' })
  })

  it('shows the tag alone when the tag fits but the caption does not', () => {
    expect(barTexts(65, 'abcde', 'wxyz')).toEqual({ tag: 'abcde' })
  })

  it('shows nothing when the tag itself does not fit, even if a caption alone would', () => {
    expect(barTexts(39, 'abcde', 'w')).toEqual({})
  })

  // No tag text at all: the caption alone takes the tag's own gate (est + 10).
  it('lets a caption take the tag gate when there is no tag', () => {
    expect(barTexts(34, undefined, 'wxyz')).toEqual({ caption: 'wxyz' })
  })

  it('hides a tagless caption 1px below the tag gate', () => {
    expect(barTexts(33, undefined, 'wxyz')).toEqual({})
  })

  it('leaves a tag exactly at TAG_MAX_CHARS untruncated', () => {
    const tag = 'y'.repeat(TAG_MAX_CHARS)
    // est = 16*6 = 96; gate = 106.
    expect(barTexts(106, tag, undefined)).toEqual({ tag })
  })

  it('truncates a tag one char past TAG_MAX_CHARS with a trailing ellipsis', () => {
    const tag = 'y'.repeat(TAG_MAX_CHARS + 1)
    const truncated = 'y'.repeat(TAG_MAX_CHARS - 1) + '…'
    expect(barTexts(106, tag, undefined)).toEqual({ tag: truncated })
  })

  it('leaves a caption exactly at CAPTION_MAX_CHARS untruncated', () => {
    const caption = 'x'.repeat(CAPTION_MAX_CHARS)
    // est = 32*6 = 192; gate = 202.
    expect(barTexts(202, undefined, caption)).toEqual({ caption })
  })

  it('truncates a caption one char past CAPTION_MAX_CHARS with a trailing ellipsis', () => {
    const caption = 'x'.repeat(CAPTION_MAX_CHARS + 1)
    const truncated = 'x'.repeat(CAPTION_MAX_CHARS - 1) + '…'
    expect(barTexts(202, undefined, caption)).toEqual({ caption: truncated })
  })
})

describe('tagLeftOffset', () => {
  const tag = '12.4K' // 5 chars -> 30px of text, 36px with its chrome

  it('measures the tag box as text plus its own chrome', () => {
    expect(tagBoxWidth(tag)).toBe(tag.length * TEXT_PX_PER_CHAR + TAG_CHROME_PX)
    expect(tagBoxWidth(tag)).toBe(36)
  })

  it('places the tag against the right edge of the width it is given', () => {
    expect(tagLeftOffset(160, tag)).toBe(160 - 36 - TAG_EDGE_MARGIN_PX)
  })

  it('follows a shrinking visible width instead of the bar edge', () => {
    // The same bar, first fully visible and then clipped by the viewport:
    // the offset only ever depends on the width passed in, so the tag slides
    // with the visible edge rather than jumping between two anchors.
    expect(tagLeftOffset(400, tag)).toBe(361)
    expect(tagLeftOffset(300, tag)).toBe(261)
    expect(tagLeftOffset(299.5, tag)).toBe(260.5)
  })

  it('never returns a negative offset', () => {
    expect(tagLeftOffset(10, tag)).toBe(0)
    expect(tagLeftOffset(0, tag)).toBe(0)
  })

  it('never has to clamp for a tag that barTexts accepted', () => {
    // barTexts' gate is estWidth + 10, and the offset consumes estWidth + 9,
    // so the narrowest accepted bar still leaves the tag a positive offset.
    const narrowest = tag.length * TEXT_PX_PER_CHAR + 10
    expect(barTexts(narrowest, tag, undefined)).toEqual({ tag })
    expect(tagLeftOffset(narrowest, tag)).toBe(1)
  })
})

describe('textColorFor', () => {
  it('picks dark text on a light background', () => {
    expect(textColorFor('#d1d5db')).toBe('#1f2937')
  })

  it('picks white text on a saturated/dark background', () => {
    expect(textColorFor('#f87171')).toBe('#ffffff')
  })

  // The whole rule palette in one place: only the two backgrounds above the
  // 0.5 luminance cut take dark text. Yellow (0.579) is why the cut sits
  // there — white 10px text on it is not readable.
  it('maps every palette color to its readable text color', () => {
    const expected: Record<string, string> = {
      '#34d399': '#ffffff', // green, luminance 0.496
      '#f87171': '#ffffff', // red, 0.330
      '#fbbf24': '#1f2937', // yellow, 0.579
      '#60a5fa': '#ffffff', // blue, 0.363
      '#9ca3af': '#ffffff', // gray, 0.364
      '#d1d5db': '#1f2937', // lightgray, 0.663
      '#a78bfa': '#ffffff', // purple, 0.336
      '#fb923c': '#ffffff', // orange, 0.414
      '#9c27b0': '#ffffff', // the implicit http-origin purple, 0.117
    }
    const actual = Object.fromEntries(
      Object.keys(expected).map((background) => [background, textColorFor(background)]),
    )
    expect(actual).toEqual(expected)
  })

  it('takes the extremes', () => {
    expect(textColorFor('#ffffff')).toBe('#1f2937')
    expect(textColorFor('#000000')).toBe('#ffffff')
  })
})

describe('deriveMarkers', () => {
  it('places two distinct values at their transformed x positions', () => {
    const tasks = [
      task({ start_ts: 110, labels: { env: 'a' } }),
      task({ start_ts: 150, labels: { env: 'b' } }),
    ]
    const pins = deriveMarkers(tasks, 'env', 100, 2)
    expect(pins).toEqual([
      { left: 20, ts: 110, values: ['a'] },
      { left: 100, ts: 150, values: ['b'] },
    ])
  })

  it('collapses three tasks sharing one value into a single pin at the earliest ts', () => {
    const tasks = [
      task({ start_ts: 30, labels: { env: 'a' } }),
      task({ start_ts: 10, labels: { env: 'a' } }),
      task({ start_ts: 20, labels: { env: 'a' } }),
    ]
    const pins = deriveMarkers(tasks, 'env', 0, 1)
    expect(pins).toEqual([{ left: 10, ts: 10, values: ['a'] }])
  })

  it('merges two pins 8px apart (within the default 12px collapse) keeping both values', () => {
    const tasks = [
      task({ start_ts: 10, labels: { env: 'a' } }),
      task({ start_ts: 18, labels: { env: 'b' } }),
    ]
    const pins = deriveMarkers(tasks, 'env', 0, 1)
    expect(pins).toEqual([{ left: 10, ts: 10, values: ['a', 'b'] }])
  })

  it('keeps two pins 13px apart separate (past the default 12px collapse)', () => {
    const tasks = [
      task({ start_ts: 10, labels: { env: 'a' } }),
      task({ start_ts: 23, labels: { env: 'b' } }),
    ]
    const pins = deriveMarkers(tasks, 'env', 0, 1)
    expect(pins).toEqual([
      { left: 10, ts: 10, values: ['a'] },
      { left: 23, ts: 23, values: ['b'] },
    ])
  })

  it('re-anchors the collapse window on the KEPT pin, not the last-visited one', () => {
    // Three pins at left 0, 8, 16 with collapsePx=12: 8 merges into 0 (8px
    // apart), but 16 must compare against the KEPT pin at 0 (16px apart, >
    // 12) rather than the just-merged pin at 8 (which would wrongly stay
    // within 8px and merge too).
    const tasks = [
      task({ start_ts: 0, labels: { env: 'a' } }),
      task({ start_ts: 8, labels: { env: 'b' } }),
      task({ start_ts: 16, labels: { env: 'c' } }),
    ]
    const pins = deriveMarkers(tasks, 'env', 0, 1, 12)
    expect(pins).toEqual([
      { left: 0, ts: 0, values: ['a', 'b'] },
      { left: 16, ts: 16, values: ['c'] },
    ])
  })

  it('ignores tasks that lack the marker label', () => {
    const tasks = [
      task({ start_ts: 10, labels: { env: 'a' } }),
      task({ start_ts: 5, labels: { other: 'x' } }),
      task({ start_ts: 1, labels: null }),
    ]
    const pins = deriveMarkers(tasks, 'env', 0, 1)
    expect(pins).toEqual([{ left: 10, ts: 10, values: ['a'] }])
  })

  it('returns an empty array for an empty markerKey', () => {
    const tasks = [task({ start_ts: 10, labels: { env: 'a' } })]
    expect(deriveMarkers(tasks, '', 0, 1)).toEqual([])
  })
})
