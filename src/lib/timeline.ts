// Pure geometry helpers for the Live timeline (Timeline.svelte).
//
// The timeline used to derive every bar's position from `now - WINDOW_SEC`,
// an origin that stepped every 250ms. That made bars (and the whole strip)
// recompute their absolute pixel position on every tick — visually a jump,
// not a slide, four times a second. The fix is a fixed epoch: `originTs` is
// chosen once (and only rarely rebased, see `shouldRebase`/`rebase`) so a
// task's on-screen position is stable between origin changes, and "moving
// forward in time" becomes real scrolling instead of re-deriving coordinates.
//
// Everything here is plain numbers in and out — no DOM, no Svelte state — so
// it can be unit tested without a browser and reused verbatim by the
// component.

/** Seconds of intentional display lag: the timeline follows `now - RENDER_DELAY_SEC`,
 * not `now` itself, so a task's tail end never draws past the edge the operator
 * is actually looking at. */
export const RENDER_DELAY_SEC = 2

export interface BarGeometry {
  left: number
  width: number
}

/**
 * Position and width of one task bar in the fixed-origin coordinate space.
 *
 * `left` is clamped to >= 0 (a task that started before `originTs` draws
 * flush against the left edge, same as the old windowStart clamp). `width`
 * is clamped to >= `minBarPx` so very short tasks stay clickable.
 */
export function barGeometry(
  startTs: number,
  endTs: number,
  originTs: number,
  pxPerSec: number,
  minBarPx: number,
): BarGeometry {
  const left = Math.max(0, (startTs - originTs) * pxPerSec)
  const width = Math.max(minBarPx, (endTs - Math.max(startTs, originTs)) * pxPerSec)
  return { left, width }
}

export interface TickMark {
  left: number
  ts: number
}

// Zoom -> label interval, ported unchanged from the reference's rebuildAxis:
// wider zoom gets finer ticks, narrower zoom gets coarser ones, so labels
// never crowd together.
function tickInterval(pxPerSec: number): number {
  let tick = 30
  if (pxPerSec >= 16) tick = 10
  if (pxPerSec >= 32) tick = 5
  if (pxPerSec < 4) tick = 60
  if (pxPerSec < 1) tick = 120
  return tick
}

/**
 * Axis tick marks between `fromTs` and `toTs`, positioned relative to
 * `originTs`.
 *
 * Positions are stable as time advances: two calls with the same `originTs`
 * and the same tick `ts` always agree on `left`, because `left` depends only
 * on the fixed origin, never on "now". Only the *set* of ticks returned
 * changes as `fromTs`/`toTs` slide forward.
 */
export function tickMarks(
  fromTs: number,
  toTs: number,
  pxPerSec: number,
  originTs: number,
): TickMark[] {
  const tick = tickInterval(pxPerSec)
  const out: TickMark[] = []
  for (let ts = Math.ceil(fromTs / tick) * tick; ts <= toTs; ts += tick) {
    out.push({ left: (ts - originTs) * pxPerSec, ts })
  }
  return out
}

/**
 * The scrollLeft that puts `renderNowTs` at the viewport's right edge.
 *
 * Never negative — early on, before the strip is a full viewport wide, the
 * "right edge" math would otherwise go negative and the viewport would
 * refuse to scroll left of 0 anyway, but callers should not depend on the
 * DOM to clamp it for them.
 */
export function followScrollLeft(
  renderNowTs: number,
  originTs: number,
  pxPerSec: number,
  viewportWidth: number,
): number {
  return Math.max(0, (renderNowTs - originTs) * pxPerSec - viewportWidth)
}

/**
 * True once the strip has grown to more than twice the visible window past
 * the origin — time to slide the origin forward rather than let the strip
 * (and the DOM node count behind it) grow without bound.
 */
export function shouldRebase(nowTs: number, originTs: number, windowSec: number): boolean {
  return nowTs - originTs > 2 * windowSec
}

/**
 * The new origin after a rebase: one window further along.
 *
 * Invariant that makes rebasing invisible on screen: for any timestamp ts,
 * `barGeometry(ts, ts, rebase(originTs, windowSec), pxPerSec, 0).left`
 * equals the old left minus `windowSec * pxPerSec`. So a rebase must be
 * paired with subtracting exactly that many pixels from scrollLeft in the
 * same tick — shifting the origin and the scroll position by the same
 * amount cancels out, and nothing appears to move.
 */
export function rebase(originTs: number, windowSec: number): number {
  return originTs + windowSec
}
