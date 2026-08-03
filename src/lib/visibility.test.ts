import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { pausableInterval, visibilityGate, DEFAULT_GRACE_MS } from './visibility'

// happy-dom exposes a real document; document.hidden derives from
// visibilityState, so the tests drive both and dispatch the event a browser
// would send.
function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (hidden ? 'hidden' : 'visible'),
  })
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => hidden,
  })
  document.dispatchEvent(new Event('visibilitychange'))
}

describe('visibilityGate', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setHidden(false)
  })
  afterEach(() => {
    vi.useRealTimers()
    setHidden(false)
  })

  it('waits out the grace period before going idle', () => {
    const onIdle = vi.fn()
    const onActive = vi.fn()
    const stop = visibilityGate({ onIdle, onActive })

    setHidden(true)
    vi.advanceTimersByTime(DEFAULT_GRACE_MS - 1)
    expect(onIdle).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(onIdle).toHaveBeenCalledTimes(1)
    stop()
  })

  it('ignores a switch away shorter than the grace period', () => {
    const onIdle = vi.fn()
    const onActive = vi.fn()
    const stop = visibilityGate({ onIdle, onActive })

    setHidden(true)
    vi.advanceTimersByTime(3000) // a brief look at another window
    setHidden(false)
    vi.advanceTimersByTime(DEFAULT_GRACE_MS * 2)

    // Neither side fires: nothing stopped, so nothing needs catching up.
    expect(onIdle).not.toHaveBeenCalled()
    expect(onActive).not.toHaveBeenCalled()
    stop()
  })

  it('calls onActive only after onIdle fired', () => {
    const onIdle = vi.fn()
    const onActive = vi.fn()
    const stop = visibilityGate({ onIdle, onActive })

    setHidden(true)
    vi.advanceTimersByTime(DEFAULT_GRACE_MS)
    expect(onIdle).toHaveBeenCalledTimes(1)

    setHidden(false)
    expect(onActive).toHaveBeenCalledTimes(1)
    stop()
  })

  it('does not re-arm the grace timer while already hidden', () => {
    const onIdle = vi.fn()
    const stop = visibilityGate({ onIdle, onActive: vi.fn() })

    setHidden(true)
    // A spurious second visibilitychange while still hidden must not restart
    // the countdown or queue a second onIdle.
    document.dispatchEvent(new Event('visibilitychange'))
    vi.advanceTimersByTime(DEFAULT_GRACE_MS * 3)
    expect(onIdle).toHaveBeenCalledTimes(1)
    stop()
  })

  it('honours a custom grace period', () => {
    const onIdle = vi.fn()
    const stop = visibilityGate({ onIdle, onActive: vi.fn(), graceMs: 500 })
    setHidden(true)
    vi.advanceTimersByTime(500)
    expect(onIdle).toHaveBeenCalledTimes(1)
    stop()
  })

  it('stops cleanly', () => {
    const onIdle = vi.fn()
    const stop = visibilityGate({ onIdle, onActive: vi.fn() })
    stop()
    setHidden(true)
    vi.advanceTimersByTime(DEFAULT_GRACE_MS * 2)
    expect(onIdle).not.toHaveBeenCalled()
  })
})

describe('pausableInterval', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setHidden(false)
  })
  afterEach(() => {
    vi.useRealTimers()
    setHidden(false)
  })

  it('runs on the interval while the tab is visible', () => {
    const fn = vi.fn()
    const stop = pausableInterval(fn, 1000)
    vi.advanceTimersByTime(3000)
    expect(fn).toHaveBeenCalledTimes(3)
    stop()
  })

  it('keeps polling through a short switch away', () => {
    const fn = vi.fn()
    const stop = pausableInterval(fn, 1000)
    setHidden(true)
    vi.advanceTimersByTime(3000) // inside the grace period
    setHidden(false)
    // Polling never stopped, so the three ticks ran and no catch-up was
    // needed — a brief switch costs nothing.
    expect(fn).toHaveBeenCalledTimes(3)
    stop()
  })

  it('stops once the tab has been hidden past the grace period', () => {
    const fn = vi.fn()
    const stop = pausableInterval(fn, 1000)
    setHidden(true)
    vi.advanceTimersByTime(DEFAULT_GRACE_MS)
    const atIdle = fn.mock.calls.length

    vi.advanceTimersByTime(60_000)
    expect(fn).toHaveBeenCalledTimes(atIdle) // nothing ran while idle
    stop()
  })

  it('catches up immediately when the tab becomes visible again', () => {
    const fn = vi.fn()
    const stop = pausableInterval(fn, 1000)
    setHidden(true)
    vi.advanceTimersByTime(DEFAULT_GRACE_MS + 60_000)
    const atIdle = fn.mock.calls.length

    setHidden(false)
    // One catch-up call fires without waiting out another interval.
    expect(fn).toHaveBeenCalledTimes(atIdle + 1)
    vi.advanceTimersByTime(1000)
    expect(fn).toHaveBeenCalledTimes(atIdle + 2)
    stop()
  })

  it('does not start a timer when created while hidden', () => {
    setHidden(true)
    const fn = vi.fn()
    const stop = pausableInterval(fn, 1000)
    vi.advanceTimersByTime(5000)
    expect(fn).toHaveBeenCalledTimes(0)
    stop()
  })

  it('runs once up front when immediate is set', () => {
    const fn = vi.fn()
    const stop = pausableInterval(fn, 1000, { immediate: true })
    expect(fn).toHaveBeenCalledTimes(1)
    stop()
  })

  it('stops cleanly and detaches its listener', () => {
    const fn = vi.fn()
    const stop = pausableInterval(fn, 1000)
    stop()
    vi.advanceTimersByTime(5000)
    expect(fn).toHaveBeenCalledTimes(0)
    // A visibility cycle after stop must not resurrect the interval.
    setHidden(true)
    vi.advanceTimersByTime(DEFAULT_GRACE_MS)
    setHidden(false)
    vi.advanceTimersByTime(5000)
    expect(fn).toHaveBeenCalledTimes(0)
  })
})
