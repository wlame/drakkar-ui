// Detach helpers (contract v1.33): presets within the maximum, the outcome
// sentences, the poll pace, the visibility rules and the time texts.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'
import { HttpError } from './api'
import {
  DETACH_FAST_POLL_MS,
  DETACH_SLOW_POLL_MS,
  NETWORK_ERROR_TEXT,
  OUTCOME_SENTENCES,
  bannerVisible,
  controlVisible,
  detachChoices,
  detachStaleSince,
  detachState,
  fmtTimeLeft,
  fmtUtcTimeMs,
  isRefusal,
  nextPollDelayMs,
  outcomeText,
  requestDetach,
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
  it('polls about once a second during a transition', () => {
    expect(nextPollDelayMs(state({ state: 'detaching' }), 0, 1000)).toBe(DETACH_FAST_POLL_MS)
    expect(nextPollDelayMs(state({ state: 'attaching' }), 0, 1000)).toBe(DETACH_FAST_POLL_MS)
  })

  it('polls fast for a few seconds after a request', () => {
    expect(nextPollDelayMs(state(), 5000, 1000)).toBe(DETACH_FAST_POLL_MS)
  })

  it('polls slowly otherwise', () => {
    expect(nextPollDelayMs(state(), 0, 1000)).toBe(DETACH_SLOW_POLL_MS)
    expect(nextPollDelayMs(state({ state: 'detached' }), 0, 1000)).toBe(DETACH_SLOW_POLL_MS)
    expect(nextPollDelayMs(null, 0, 1000)).toBe(DETACH_SLOW_POLL_MS)
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
  it('writes an epoch-milliseconds time in UTC with the label', () => {
    expect(fmtUtcTimeMs(Date.UTC(2026, 10, 16, 14, 2, 11))).toBe('14:02:11 UTC')
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

  it('drops a read that started before a POST answer', async () => {
    vi.useFakeTimers()
    let releaseRead: (r: Response) => void = () => {}
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'POST') {
          return Promise.resolve(
            new Response(JSON.stringify(state({ state: 'detaching', origin: 'operator' })), {
              status: 202,
            }),
          )
        }
        return new Promise<Response>((resolve) => {
          releaseRead = resolve
        })
      }),
    )
    const leave = useDetachState()
    await requestDetach(900, '')
    expect(get(detachState)?.state).toBe('detaching')
    releaseRead(answer(state()))
    await vi.advanceTimersByTimeAsync(0)
    expect(get(detachState)?.state).toBe('detaching')

    // The next read starts after the POST answer, so it is taken.
    await vi.advanceTimersByTimeAsync(DETACH_FAST_POLL_MS)
    releaseRead(
      answer(state({ state: 'detached', origin: 'operator', until_ms: Date.now() + 900_000 })),
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(get(detachState)?.state).toBe('detached')
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
