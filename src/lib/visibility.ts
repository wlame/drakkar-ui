// Work that stops when nobody is looking at the tab.
//
// Two costs are involved, and they are not the same:
//
//   * HTTP polling — each poll is several requests, and each request costs the
//     backend a main-loop dispatch. Ten background tabs were paying that with
//     nobody watching.
//   * WebSocket frames — a hidden tab still parses every frame and applies
//     every event to reactive state. Browsers throttle RENDERING in a hidden
//     tab, but they do not throttle WebSocket message delivery, so the
//     JavaScript keeps running. On a fan-out workload that is hundreds of
//     events per second per hidden tab.
//
// Both are driven from one gate so they share a single grace period and can
// never disagree about whether the tab is idle.
//
// The grace period matters for normal use: an operator who switches to another
// window for three seconds and comes back should cost nothing at all. Stopping
// instantly would make every brief switch trigger a catch-up round trip.

/** How long a tab stays hidden before its work is considered idle. */
export const DEFAULT_GRACE_MS = 15_000

export interface VisibilityGateOptions {
  /** Fires once the tab has been hidden continuously for `graceMs`. */
  onIdle: () => void
  /** Fires when the tab becomes visible again — but only after `onIdle` ran. */
  onActive: () => void
  graceMs?: number
}

/**
 * Call `onIdle` after the tab has been hidden for `graceMs`, and `onActive`
 * when it comes back.
 *
 * `onActive` fires only if `onIdle` fired first, so a brief switch away is a
 * no-op on both sides. Returns a stop function; call it on unmount.
 */
export function visibilityGate(opts: VisibilityGateOptions): () => void {
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS
  let idle = false
  let graceTimer: ReturnType<typeof setTimeout> | undefined

  const hidden = () => typeof document !== 'undefined' && document.hidden

  function clearGrace() {
    if (graceTimer === undefined) return
    clearTimeout(graceTimer)
    graceTimer = undefined
  }

  function onVisibilityChange() {
    if (hidden()) {
      // Already idle, or already counting down — nothing to do.
      if (idle || graceTimer !== undefined) return
      graceTimer = setTimeout(() => {
        graceTimer = undefined
        idle = true
        opts.onIdle()
      }, graceMs)
      return
    }
    clearGrace()
    if (!idle) return // the tab came back inside the grace period
    idle = false
    opts.onActive()
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange)
  }

  return () => {
    clearGrace()
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }
}

export interface PausableIntervalOptions {
  /** Run the callback once immediately on start. Defaults to false. */
  immediate?: boolean
  /**
   * Catch-up call used instead of `fn` when the tab becomes visible again.
   *
   * A caller whose `fn` only advances a scheduler tick needs this: running one
   * more tick usually fires nothing, so the operator would keep looking at the
   * numbers from before the tab was hidden. Defaults to `fn`.
   */
  onResume?: () => void
  graceMs?: number
}

/**
 * Run `fn` every `ms`, pausing once the tab has been hidden for the grace
 * period and catching up the moment it becomes visible again.
 *
 * Returns a stop function; call it on unmount. Safe where `document` is
 * undefined (SSR, tests) — there it degrades to a plain interval.
 */
export function pausableInterval(
  fn: () => void,
  ms: number,
  opts: PausableIntervalOptions = {},
): () => void {
  let timer: ReturnType<typeof setInterval> | undefined

  function start() {
    if (timer !== undefined) return
    timer = setInterval(fn, ms)
  }

  function stop() {
    if (timer === undefined) return
    clearInterval(timer)
    timer = undefined
  }

  const stopGate = visibilityGate({
    graceMs: opts.graceMs,
    onIdle: stop,
    onActive: () => {
      // Catch up before resuming the cadence: the tab may have been hidden
      // for far longer than one interval.
      const catchUp = opts.onResume ?? fn
      catchUp()
      start()
    },
  })

  if (opts.immediate) fn()
  if (typeof document === 'undefined' || !document.hidden) start()

  return () => {
    stop()
    stopGate()
  }
}

/** True when the tab is currently hidden. */
export function isHidden(): boolean {
  return typeof document !== 'undefined' && document.hidden
}
