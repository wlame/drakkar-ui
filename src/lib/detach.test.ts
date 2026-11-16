// Detach helpers (contract v1.33): presets within the maximum, the outcome
// sentences, the poll pace, the visibility rules and the time texts.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'
import { HttpError } from './api'
import {
  DETACH_ABSENT_POLL_MS,
  DETACH_FAST_POLL_MS,
  DETACH_SLOW_POLL_MS,
  NETWORK_ERROR_TEXT,
  OUTCOME_SENTENCES,
  bannerVisible,
  controlVisible,
  detachStateText,
  detachChoices,
  fmtDetachDuration,
  detachStaleSince,
  detachState,
  fmtTimeLeft,
  fmtUtcTimeMs,
  isRefusal,
  nextPollDelayMs,
  outcomeText,
  requestAttach,
  requestShown,
  requestErrorText,
  resetDetachForTests,
  useDetachState,
} from './detach'
import type { DetachState } from './types'

function state(overrides: Partial<DetachState> = {}): DetachState {
  return {
    enabled: true,
    ui_enabled: true,
    state: 'attached',
    origin: null,
    reason: '',
    since_ms: null,
    until_ms: null,
    max_duration_seconds: 3600,
    default_duration_seconds: 900,
    last_request: null,
    ...overrides,
  }
}

describe('detachChoices', () => {
  it('offers 5 min, 15 min and 1 h when the maximum allows all three', () => {
    expect(detachChoices(3600)).toEqual([300, 900, 3600])
  })

  it('leaves out a preset above the maximum', () => {
    expect(detachChoices(1800)).toEqual([300, 900])
    expect(detachChoices(300)).toEqual([300])
  })

  it('offers the maximum alone when no preset fits', () => {
    expect(detachChoices(120)).toEqual([120])
  })
})

describe('outcomeText', () => {
  const reasons = [
    'not_running',
    'stopping',
    'disabled',
    'inside_pipeline_hook',
    'already_detached',
    'cooldown',
    'too_few_workers',
    'budget_full',
    'store_unavailable',
    'leave_failed',
    'held_by_operator',
    'join_failed',
  ]

  it('has a plain sentence for every refusal reason and attach answer', () => {
    for (const reason of reasons) {
      expect(OUTCOME_SENTENCES, `missing sentence for ${reason}`).toHaveProperty(reason)
      expect(outcomeText(reason)).toMatch(/^[A-Z].*\.$/)
    }
  })

  it('says what to do when the budget is full', () => {
    expect(outcomeText('budget_full')).toBe(
      'The limit of detached workers in this group is reached. Attach another worker first, or wait.',
    )
  })

  it('says what each handler-only answer means for the operator', () => {
    expect(outcomeText('already_detached')).toBe(
      'The handler asked to detach, but an operator detach is active. Nothing changed.',
    )
    expect(outcomeText('leave_failed')).toBe(
      'The worker could not leave its group in time. It returns to the group and may show attaching for a moment.',
    )
  })

  it('shows an unknown value as it is', () => {
    expect(outcomeText('brand_new_reason')).toBe('brand_new_reason')
  })

  it('tells a success from a refusal', () => {
    expect(isRefusal('detached')).toBe(false)
    expect(isRefusal('attached')).toBe(false)
    expect(isRefusal('cooldown')).toBe(true)
    expect(isRefusal('brand_new_reason')).toBe(true)
  })
})

describe('nextPollDelayMs', () => {
  const pace = (over: Partial<Parameters<typeof nextPollDelayMs>[0]> = {}) =>
    nextPollDelayMs({
      state: state(),
      absent: false,
      failedReads: 0,
      fastUntilMs: 0,
      nowMs: 1000,
      ...over,
    })

  it('polls about once a second during a transition', () => {
    expect(pace({ state: state({ state: 'detaching' }) })).toBe(DETACH_FAST_POLL_MS)
    expect(pace({ state: state({ state: 'attaching' }) })).toBe(DETACH_FAST_POLL_MS)
  })

  it('polls fast for a few seconds after a request', () => {
    expect(pace({ fastUntilMs: 5000 })).toBe(DETACH_FAST_POLL_MS)
  })

  it('polls slowly otherwise', () => {
    expect(pace()).toBe(DETACH_SLOW_POLL_MS)
    expect(pace({ state: state({ state: 'detached' }) })).toBe(DETACH_SLOW_POLL_MS)
    expect(pace({ state: null })).toBe(DETACH_SLOW_POLL_MS)
  })

  it('polls slowly while reads fail, even during a transition', () => {
    expect(pace({ state: state({ state: 'detaching' }), failedReads: 2 })).toBe(DETACH_SLOW_POLL_MS)
    expect(pace({ state: state({ state: 'detaching' }), failedReads: 1 })).toBe(DETACH_FAST_POLL_MS)
  })

  it('checks once a minute while the feature is absent', () => {
    expect(pace({ state: null, absent: true })).toBe(DETACH_ABSENT_POLL_MS)
    expect(DETACH_ABSENT_POLL_MS).toBe(60_000)
  })
})

describe('fmtDetachDuration', () => {
  it('writes whole minutes and hours, and the seconds that are left', () => {
    expect(fmtDetachDuration(45)).toBe('45 s')
    expect(fmtDetachDuration(90)).toBe('1 min 30 s')
    expect(fmtDetachDuration(300)).toBe('5 min')
    expect(fmtDetachDuration(5400)).toBe('90 min')
    expect(fmtDetachDuration(3600)).toBe('1 h')
    expect(fmtDetachDuration(7200)).toBe('2 h')
  })
})

describe('detachStateText', () => {
  it('names the two transitions and shows any other value as it is', () => {
    expect(detachStateText('detaching')).toBe('Detaching…')
    expect(detachStateText('attaching')).toBe('Attaching…')
    expect(detachStateText('parked')).toBe('State: parked')
  })
})

describe('requestShown', () => {
  const sent = { state: 'attached', lastRequestAtMs: 1000 }

  it('is false while the state and last_request are as they were', () => {
    expect(
      requestShown(
        sent,
        state({
          last_request: { origin: 'operator', action: 'detach', outcome: 'cooldown', at_ms: 1000 },
        }),
      ),
    ).toBe(false)
  })

  it('is true when the state moved', () => {
    expect(requestShown(sent, state({ state: 'detaching' }))).toBe(true)
  })

  it('is true when last_request is newer, or appears for the first time', () => {
    const newer = {
      origin: 'operator' as const,
      action: 'detach' as const,
      outcome: 'budget_full',
      at_ms: 2000,
    }
    expect(requestShown(sent, state({ last_request: newer }))).toBe(true)
    expect(
      requestShown({ state: 'attached', lastRequestAtMs: null }, state({ last_request: newer })),
    ).toBe(true)
  })

  it('is false without a state to compare', () => {
    expect(requestShown(sent, null)).toBe(false)
  })
})

describe('visibility', () => {
  it('shows the control only when the feature and the UI switch are on', () => {
    expect(controlVisible(state())).toBe(true)
    expect(controlVisible(state({ enabled: false }))).toBe(false)
    expect(controlVisible(state({ ui_enabled: false }))).toBe(false)
    expect(controlVisible(null)).toBe(false)
  })

  it('shows the banner for every state but attached', () => {
    expect(bannerVisible(state())).toBe(false)
    expect(bannerVisible(state({ state: 'detached' }))).toBe(true)
    expect(bannerVisible(state({ state: 'detaching' }))).toBe(true)
    expect(bannerVisible(state({ state: 'detached', enabled: false }))).toBe(false)
    expect(bannerVisible(null)).toBe(false)
  })
})

describe('fmtTimeLeft', () => {
  it('writes minutes and seconds, and hours when needed', () => {
    expect(fmtTimeLeft(65_000)).toBe('1:05')
    expect(fmtTimeLeft(3_725_000)).toBe('1:02:05')
  })

  it('never goes below zero', () => {
    expect(fmtTimeLeft(-5_000)).toBe('0:00')
  })
})

describe('fmtUtcTimeMs', () => {
  const now = Date.UTC(2026, 10, 16, 18, 0, 0)

  it('writes a time of the current UTC day without the date', () => {
    expect(fmtUtcTimeMs(Date.UTC(2026, 10, 16, 14, 2, 11), now)).toBe('14:02:11 UTC')
  })

  it('adds the date for a time on another UTC day', () => {
    expect(fmtUtcTimeMs(Date.UTC(2026, 10, 21, 9, 30, 0), now)).toBe('2026-11-21 09:30:00 UTC')
    expect(fmtUtcTimeMs(Date.UTC(2026, 10, 15, 23, 59, 59), now)).toBe('2026-11-15 23:59:59 UTC')
  })
})

describe('requestErrorText', () => {
  it('shows a string detail as it is', () => {
    const error = new HttpError(
      'POST',
      '/debug/detach',
      403,
      '{"detail":"Detach from the UI is off; set ui.detach_enabled to true."}',
    )
    expect(requestErrorText(error)).toBe(
      'Detach from the UI is off; set ui.detach_enabled to true.',
    )
  })

  it('joins the msg fields of a validation answer', () => {
    const body = JSON.stringify({
      detail: [
        { loc: ['body', 'duration_seconds'], msg: 'must be at least 10' },
        { loc: ['body', 'reason'], msg: 'must be a string' },
      ],
    })
    expect(requestErrorText(new HttpError('POST', '/debug/detach', 422, body))).toBe(
      'must be at least 10; must be a string',
    )
  })

  it('gives its own sentence for a 503, whatever the detail says', () => {
    const error = new HttpError(
      'POST',
      '/debug/detach',
      503,
      '{"detail":"The worker did not answer in time; try again"}',
    )
    expect(requestErrorText(error)).toBe(
      'The worker did not answer in time. Check the state before you ask again.',
    )
  })

  it('gives the status for an answer without detail', () => {
    expect(requestErrorText(new HttpError('POST', '/debug/attach', 500, 'boom'))).toBe(
      'The worker answered HTTP 500.',
    )
  })

  it('gives one sentence for a request that got no answer', () => {
    expect(requestErrorText(new TypeError('Failed to fetch'))).toBe(NETWORK_ERROR_TEXT)
    expect(NETWORK_ERROR_TEXT).toBe(
      'The worker did not answer. Check the connection and try again.',
    )
  })
})

function answer(value: DetachState): Response {
  return new Response(JSON.stringify(value), { status: 200 })
}

describe('the shared poll loop', () => {
  afterEach(() => {
    resetDetachForTests()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('does not publish the 202 answer as the state; the next read carries it', async () => {
    vi.useFakeTimers()
    let onWorker = state({ state: 'detached', origin: 'operator', until_ms: Date.now() + 60_000 })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'POST') {
          // The worker answers with its state from before the request.
          const before = onWorker
          onWorker = state({ state: 'attaching', origin: 'operator' })
          return new Response(JSON.stringify(before), { status: 202 })
        }
        return answer(onWorker)
      }),
    )
    const leave = useDetachState()
    await vi.advanceTimersByTimeAsync(0)
    const published = vi.fn()
    const stop = detachState.subscribe(published)
    published.mockClear()

    await requestAttach()
    expect(published).not.toHaveBeenCalled()
    expect(get(detachState)?.state).toBe('detached')

    // The fast pace after a request: the next read comes within a second.
    await vi.advanceTimersByTimeAsync(DETACH_FAST_POLL_MS)
    expect(get(detachState)?.state).toBe('attaching')
    stop()
    leave()
  })

  it('keeps checking once a minute after a 404, and shows the feature when it appears', async () => {
    vi.useFakeTimers()
    let present = false
    const reads = vi.fn(async () =>
      present ? answer(state()) : new Response('Not Found', { status: 404 }),
    )
    vi.stubGlobal('fetch', reads)
    const leave = useDetachState()
    await vi.advanceTimersByTimeAsync(0)
    expect(get(detachState)).toBeNull()
    await vi.advanceTimersByTimeAsync(DETACH_ABSENT_POLL_MS - 1)
    expect(reads).toHaveBeenCalledTimes(1)
    present = true
    await vi.advanceTimersByTimeAsync(1)
    expect(reads).toHaveBeenCalledTimes(2)
    expect(get(detachState)?.enabled).toBe(true)
    leave()
  })

  it('keeps checking once a minute while the feature is off', async () => {
    vi.useFakeTimers()
    const reads = vi.fn(async () => answer(state({ enabled: false })))
    vi.stubGlobal('fetch', reads)
    const leave = useDetachState()
    await vi.advanceTimersByTimeAsync(DETACH_ABSENT_POLL_MS * 2)
    expect(reads).toHaveBeenCalledTimes(3)
    leave()
  })

  it('polls slowly while reads fail during a transition', async () => {
    vi.useFakeTimers()
    let failing = false
    const reads = vi.fn(async () =>
      failing ? new Response('boom', { status: 500 }) : answer(state({ state: 'detaching' })),
    )
    vi.stubGlobal('fetch', reads)
    const leave = useDetachState()
    await vi.advanceTimersByTimeAsync(0)
    failing = true
    // Two failed reads at the fast pace, then the slow pace.
    await vi.advanceTimersByTimeAsync(2 * DETACH_FAST_POLL_MS)
    expect(reads).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(DETACH_SLOW_POLL_MS - 1)
    expect(reads).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(reads).toHaveBeenCalledTimes(4)
    leave()
  })

  it('keeps the last state when a read fails with something other than 404', async () => {
    vi.useFakeTimers()
    const detached = state({ state: 'detached', origin: 'handler', until_ms: Date.now() + 60_000 })
    let failing = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => (failing ? new Response('boom', { status: 500 }) : answer(detached))),
    )
    const leave = useDetachState()
    await vi.advanceTimersByTimeAsync(0)
    expect(get(detachState)?.state).toBe('detached')
    failing = true
    await vi.advanceTimersByTimeAsync(DETACH_SLOW_POLL_MS * 2)
    expect(get(detachState)?.state).toBe('detached')
    leave()
  })

  it('forgets every user on reset', async () => {
    vi.useFakeTimers()
    const reads = vi.fn(async () => answer(state()))
    vi.stubGlobal('fetch', reads)
    useDetachState()
    await vi.advanceTimersByTimeAsync(0)
    resetDetachForTests()
    expect(get(detachState)).toBeNull()
    const calls = reads.mock.calls.length
    await vi.advanceTimersByTimeAsync(DETACH_SLOW_POLL_MS * 3)
    expect(reads.mock.calls.length).toBe(calls)
  })
})

describe('the stale sign', () => {
  afterEach(() => {
    resetDetachForTests()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  // GET answers come from `answers` in order; the last one repeats.
  function serve(answers: (() => Response)[]) {
    let index = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => answers[Math.min(index++, answers.length - 1)]()),
    )
  }

  const detached = () =>
    answer(state({ state: 'detached', origin: 'operator', until_ms: Date.now() + 600_000 }))
  const failure = () => new Response('boom', { status: 500 })

  it('is set after two failed reads in a row, with the time of the last good read', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.UTC(2026, 10, 16, 14, 0, 0))
    serve([detached, failure])
    const leave = useDetachState()
    await vi.advanceTimersByTimeAsync(0)
    const goodReadAt = Date.now()
    expect(get(detachStaleSince)).toBeNull()

    await vi.advanceTimersByTimeAsync(DETACH_SLOW_POLL_MS)
    expect(get(detachStaleSince)).toBeNull()

    await vi.advanceTimersByTimeAsync(DETACH_SLOW_POLL_MS)
    expect(get(detachStaleSince)).toBe(goodReadAt)
    expect(get(detachState)?.state).toBe('detached')
    leave()
  })

  it('clears on the first good read', async () => {
    vi.useFakeTimers()
    serve([detached, failure, failure, detached])
    const leave = useDetachState()
    await vi.advanceTimersByTimeAsync(DETACH_SLOW_POLL_MS * 2)
    expect(get(detachStaleSince)).not.toBeNull()
    await vi.advanceTimersByTimeAsync(DETACH_SLOW_POLL_MS)
    expect(get(detachStaleSince)).toBeNull()
    leave()
  })

  it('a 404 still hides the feature at once and sets no sign', async () => {
    vi.useFakeTimers()
    serve([detached, () => new Response('Not Found', { status: 404 })])
    const leave = useDetachState()
    await vi.advanceTimersByTimeAsync(DETACH_SLOW_POLL_MS)
    expect(get(detachState)).toBeNull()
    expect(get(detachStaleSince)).toBeNull()
    leave()
  })
})
