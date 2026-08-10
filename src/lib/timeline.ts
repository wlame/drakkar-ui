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

import type { TaskView } from './live'

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

/** Char cap for a bar's tag text before it gets truncated with an ellipsis. */
export const TAG_MAX_CHARS = 16
/** Char cap for a bar's caption text before it gets truncated with an ellipsis. */
export const CAPTION_MAX_CHARS = 32
/** Rough monospace-ish width estimate per character, used to decide what fits
 * a bar without touching the DOM (no canvas measureText, no layout pass). */
export const TEXT_PX_PER_CHAR = 6

// Fixed gaps in the fit math, in px: 10 is the padding a lone piece of text
// needs from the bar edges; 12 is the gap between the tag and the caption
// when both are drawn.
const EDGE_GAP_PX = 10
const TAG_CAPTION_GAP_PX = 12

/**
 * Truncates `text` to at most `maxChars`, replacing the tail with a single
 * ellipsis character when it would otherwise overflow — so the returned
 * string's length never exceeds `maxChars`.
 */
function truncateToChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars - 1) + '…'
}

// Width a piece of (already-truncated) text needs to draw, per TEXT_PX_PER_CHAR.
function estWidth(text: string): number {
  return text.length * TEXT_PX_PER_CHAR
}

/**
 * Decides which of a bar's tag/caption fit within `barWidth`, truncating
 * each to its char cap first so the width estimate reflects what would
 * actually be drawn rather than the raw label length.
 *
 * Priority: the tag is tried first; the caption is only tried in the width
 * left over once the tag fits. With no tag text, the caption is tried alone
 * against the tag's own gate — otherwise a caption-only bar would need to
 * clear a gap meant for a tag that's never drawn.
 */
export function barTexts(
  barWidth: number,
  tag: string | undefined,
  caption: string | undefined,
): { tag?: string; caption?: string } {
  const tagText = tag ? truncateToChars(tag, TAG_MAX_CHARS) : undefined
  const captionText = caption ? truncateToChars(caption, CAPTION_MAX_CHARS) : undefined

  if (!tagText) {
    if (captionText && barWidth >= estWidth(captionText) + EDGE_GAP_PX) {
      return { caption: captionText }
    }
    return {}
  }

  if (barWidth < estWidth(tagText) + EDGE_GAP_PX) return {}

  const result: { tag?: string; caption?: string } = { tag: tagText }
  if (captionText) {
    const remaining = barWidth - estWidth(tagText) - TAG_CAPTION_GAP_PX
    if (remaining >= estWidth(captionText)) result.caption = captionText
  }
  return result
}

// WCAG relative-luminance gamma correction for one sRGB channel (0-255 in, 0-1 out).
function srgbChannelLuminance(channel255: number): number {
  const c = channel255 / 255
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

/**
 * Picks a readable text color for a background hex color: dark slate on
 * light backgrounds, white on dark/saturated ones, based on WCAG relative
 * luminance (> 0.6 counts as light).
 */
export function textColorFor(bgHex: string): string {
  const hex = bgHex.replace('#', '')
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  const luminance =
    0.2126 * srgbChannelLuminance(r) +
    0.7152 * srgbChannelLuminance(g) +
    0.0722 * srgbChannelLuminance(b)
  return luminance > 0.6 ? '#1f2937' : '#ffffff'
}

export interface MarkerPin {
  left: number
  ts: number
  values: string[]
}

const DEFAULT_COLLAPSE_PX = 12

/**
 * One pin per distinct value of the `markerKey` label seen across `tasks`,
 * positioned at that value's earliest `start_ts`, sorted left to right.
 *
 * Pins landing within `collapsePx` of the previous *kept* pin merge into it
 * — `values` concatenated in first-seen order, keeping the earlier pin's
 * `left`/`ts` — so a burst of near-simultaneous distinct values doesn't draw
 * as unreadable overlapping labels. Tasks without the label are ignored; an
 * empty `markerKey` means "no marker configured", so this returns `[]`.
 */
export function deriveMarkers(
  tasks: TaskView[],
  markerKey: string,
  originTs: number,
  pxPerSec: number,
  collapsePx: number = DEFAULT_COLLAPSE_PX,
): MarkerPin[] {
  if (!markerKey) return []

  const earliestTsByValue = new Map<string, number>()
  for (const t of tasks) {
    const value = t.labels?.[markerKey]
    if (value === undefined) continue
    const earliest = earliestTsByValue.get(value)
    if (earliest === undefined || t.start_ts < earliest) {
      earliestTsByValue.set(value, t.start_ts)
    }
  }

  const pins = [...earliestTsByValue.entries()]
    .sort(([, tsA], [, tsB]) => tsA - tsB)
    .map(([value, ts]) => ({ left: (ts - originTs) * pxPerSec, ts, values: [value] }))

  const merged: MarkerPin[] = []
  for (const pin of pins) {
    const prevKept = merged[merged.length - 1]
    if (prevKept && pin.left - prevKept.left <= collapsePx) {
      prevKept.values.push(...pin.values)
    } else {
      merged.push(pin)
    }
  }
  return merged
}
