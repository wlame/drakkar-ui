// Split jobs panel helpers (contract v1.34): merging the jobs the workers of a
// cluster report, the summary line, the health marks, the poll pace and the
// shared poll loop with its stale sign.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'
import { api } from './api'
import { identity } from './config'
import {
  MALFORMED_ANSWER_REASON,
  SPLIT_ABSENT_POLL_MS,
  anyWorkerSplits,
  isSplitState,
  SPLIT_POLL_MS,
  jobHealth,
  jobLabel,
  mergeSplitJobs,
  nearTimeoutThreshold,
  nextSplitPollDelayMs,
  ownerState,
  progressPercent,
  resetSplitForTests,
  restoringTooLong,
  splitStaleSince,
  splitSummary,
  splitTraceHref,
  splitView,
  summaryText,
  timeLeftSeconds,
  useSplitState,
} from './split'
import type { SplitJob, SplitState, WorkerPeer } from './types'

function job(overrides: Partial<SplitJob> = {}): SplitJob {
  return {
    partition: 7,
    offset: 500,
    request_id: 'req_1',
    attempt: 1,
    phase: 'waiting',
    parts: 100,
    received: 40,
    failed: 0,
    dlq_parts: 0,
    tasks_succeeded: 0,
    tasks_failed: 0,
    opened_at: '2026-11-21T10:00:00.000000Z',
    age_seconds: 600,
    last_progress_at: null,
    timeout_at: null,
    timeout_kind: null,
    ...overrides,
  }
}

function splitState(overrides: Partial<SplitState> = {}): SplitState {
  return {
    enabled: true,
    worker: { name: 'worker-1', instance: 'a1b2c3d4e5f60718' },
    source_topic: 'requests',
    consumer_group: 'g1',
    parts_topic: 'requests_g1_split_parts',
    results_topic: 'requests_g1_split_results',
    parts_partition_base: 1000000,
    settings: { job_timeout_seconds: 86400, idle_timeout_seconds: 0, max_attempts: 3 },
    partitions: [],
    jobs: [],
    jobs_total: 0,
    result_write_failures_total: 0,
    ...overrides,
  }
}

describe('nextSplitPollDelayMs', () => {
  it('polls every 5 s while a worker splits and every 60 s otherwise', () => {
    expect(nextSplitPollDelayMs(true)).toBe(5000)
    expect(nextSplitPollDelayMs(false)).toBe(60000)
    expect(SPLIT_POLL_MS).toBe(5000)
    expect(SPLIT_ABSENT_POLL_MS).toBe(60000)
  })
})

describe('mergeSplitJobs', () => {
  it('gives one row for a job two workers report, naming both owners sorted', () => {
    const rows = mergeSplitJobs([
      { worker: 'worker-2', state: splitState({ jobs: [job()] }) },
      { worker: 'worker-1', state: splitState({ jobs: [job({ received: 41 })] }) },
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0].owners).toEqual(['worker-1', 'worker-2'])
    expect(rows[0].received).toBe(41)
    expect(rows[0].reportedBy).toBe('worker-1')
    const results = [
      { worker: 'worker-2', base: 'http://w2', state: splitState({ jobs: [job()] }) },
      { worker: 'worker-1', base: '', state: splitState({ jobs: [job({ received: 41 })] }) },
    ]
    expect(ownerState(rows[0], results)?.base).toBe('')
  })

  it('orders the rows by opened_at, oldest first', () => {
    const rows = mergeSplitJobs([
      {
        worker: 'worker-1',
        state: splitState({
          jobs: [
            job({ offset: 2, opened_at: '2026-11-21T11:00:00.000000Z' }),
            job({ offset: 1, opened_at: '2026-11-21T09:00:00.000000Z' }),
          ],
        }),
      },
      {
        worker: 'worker-2',
        state: splitState({
          jobs: [job({ partition: 3, offset: 9, opened_at: '2026-11-21T10:00:00.000000Z' })],
        }),
      },
    ])
    expect(rows.map((r) => `${r.partition}:${r.offset}`)).toEqual(['7:1', '3:9', '7:2'])
  })
})

describe('splitSummary', () => {
  it('counts open jobs and parts left, leaving out a job before its split is done', () => {
    const summary = splitSummary(
      [
        {
          worker: 'worker-1',
          state: splitState({
            jobs: [
              job({ parts: 100, received: 40, age_seconds: 600 }),
              job({ offset: 501, parts: null, received: 0, phase: 'splitting', age_seconds: 30 }),
            ],
          }),
        },
      ],
      [],
    )
    expect(summary.openJobs).toBe(2)
    expect(summary.partsLeft).toBe(60)
    expect(summary.oldestAgeSeconds).toBe(600)
  })

  it('lists restoring partitions, unanswered workers and write failures', () => {
    const summary = splitSummary(
      [
        {
          worker: 'worker-1',
          state: splitState({
            partitions: [
              {
                partition: 4,
                state: 'restoring',
                state_seconds: 130,
                read_position: null,
                open_jobs: null,
                closed_jobs: null,
              },
              {
                partition: 5,
                state: 'live',
                state_seconds: 10,
                read_position: 3,
                open_jobs: 0,
                closed_jobs: 0,
              },
            ],
            result_write_failures_total: 2,
          }),
        },
        { worker: 'worker-3', state: splitState() },
      ],
      [{ worker: 'worker-2', reason: 'timed out' }],
    )
    expect(summary.restoring).toEqual([{ worker: 'worker-1', partition: 4, seconds: 130 }])
    expect(summary.unanswered).toEqual([{ worker: 'worker-2', reason: 'timed out' }])
    expect(summary.writeFailures).toEqual([{ worker: 'worker-1', count: 2 }])
    expect(summary.oldestAgeSeconds).toBeNull()
  })

  it('reads as one line', () => {
    const text = summaryText({
      openJobs: 2,
      partsLeft: 60,
      oldestAgeSeconds: 600,
      restoring: [{ worker: 'worker-1', partition: 4, seconds: 130 }],
      unanswered: [{ worker: 'worker-2', reason: 'timed out' }],
      notAvailable: [],
      writeFailures: [],
    })
    expect(text).toBe(
      '2 open jobs · 60 parts left · oldest 10m 0s · 1 restoring partition · 1 worker did not answer',
    )
  })

  it('says no oldest age when there are no open jobs', () => {
    expect(
      summaryText({
        openJobs: 0,
        partsLeft: 0,
        oldestAgeSeconds: null,
        restoring: [],
        unanswered: [],
        notAvailable: [],
        writeFailures: [],
      }),
    ).toBe('0 open jobs · 0 parts left')
  })
})

describe('jobHealth', () => {
  const now = Date.UTC(2026, 10, 21, 12, 0, 0)
  const at = (secondsLeft: number) => new Date(now + secondsLeft * 1000).toISOString()
  const settings = (jobTimeout: number) => ({
    job_timeout_seconds: jobTimeout,
    idle_timeout_seconds: 0,
    max_attempts: 3,
  })
  const row = (overrides: Partial<SplitJob>) => ({
    ...job(overrides),
    owners: ['worker-1'],
    reportedBy: 'worker-1',
  })

  it('marks a job with 9 % of its timeout left, not one with 11 %', () => {
    const day = 86400
    expect(
      jobHealth(row({ timeout_at: at(day * 0.09), timeout_kind: 'job' }), settings(day), now),
    ).toEqual(['near_timeout'])
    expect(
      jobHealth(row({ timeout_at: at(day * 0.11), timeout_kind: 'job' }), settings(day), now),
    ).toEqual([])
  })

  it('marks a job with 299 s left, not one with 301 s, by the 300 s floor', () => {
    expect(
      jobHealth(row({ timeout_at: at(299), timeout_kind: 'job' }), settings(1800), now),
    ).toEqual(['near_timeout'])
    expect(
      jobHealth(row({ timeout_at: at(301), timeout_kind: 'job' }), settings(1800), now),
    ).toEqual([])
  })

  it('caps the threshold at a quarter of a short timeout', () => {
    expect(
      jobHealth(row({ timeout_at: at(249), timeout_kind: 'job' }), settings(1000), now),
    ).toEqual(['near_timeout'])
    expect(
      jobHealth(row({ timeout_at: at(251), timeout_kind: 'job' }), settings(1000), now),
    ).toEqual([])
    expect(jobHealth(row({ timeout_at: at(70), timeout_kind: 'job' }), settings(300), now)).toEqual(
      ['near_timeout'],
    )
    expect(
      jobHealth(row({ timeout_at: at(100), timeout_kind: 'job' }), settings(300), now),
    ).toEqual([])
  })

  it.each([
    [300, 75],
    [1000, 250],
    [1800, 300],
    [86400, 8640],
  ])('takes min(max(10 %%, 300 s), 25 %%) of a %d s timeout', (timeout, threshold) => {
    expect(nearTimeoutThreshold(timeout)).toBeCloseTo(threshold, 9)
  })

  it('takes the idle timeout for an idle deadline', () => {
    const idle = { job_timeout_seconds: 86400, idle_timeout_seconds: 10000, max_attempts: 3 }
    expect(jobHealth(row({ timeout_at: at(900), timeout_kind: 'idle' }), idle, now)).toEqual([
      'near_timeout',
    ])
    expect(jobHealth(row({ timeout_at: at(1100), timeout_kind: 'idle' }), idle, now)).toEqual([])
  })

  it('marks failed parts, and nothing without a timeout', () => {
    expect(jobHealth(row({ failed: 2 }), settings(86400), now)).toEqual(['failed_parts'])
    expect(jobHealth(row({}), null, now)).toEqual([])
  })

  it('counts the time left from the timeout time', () => {
    expect(timeLeftSeconds(job({ timeout_at: at(90) }), now)).toBe(90)
    expect(timeLeftSeconds(job({ timeout_at: null }), now)).toBeNull()
  })
})

describe('row texts', () => {
  it('names the attempt only above 1', () => {
    expect(jobLabel(job())).toBe('7:500')
    expect(jobLabel(job({ attempt: 2 }))).toBe('7:500 (attempt 2)')
  })

  it('has no percentage before the split is done', () => {
    expect(progressPercent(job({ parts: null }))).toBeNull()
    expect(progressPercent(job({ parts: 0, received: 0 }))).toBe(100)
    expect(progressPercent(job({ parts: 200, received: 50 }))).toBe(25)
  })

  it('links the Trace tab with the job label', () => {
    expect(splitTraceHref(job())).toBe('/debug#trace-label/split_job=7%3A500')
  })

  it('marks a partition restoring for more than 120 s', () => {
    expect(restoringTooLong(120)).toBe(false)
    expect(restoringTooLong(121)).toBe(true)
  })
})

describe('the shared poll loop', () => {
  afterEach(() => {
    resetSplitForTests()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const self: WorkerPeer = {
    worker_name: 'worker-1',
    cluster: 'main',
    url: '',
    is_current: true,
    ip_address: null,
    debug_port: null,
    debug_url: null,
    split: true,
  }

  function json(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200 })
  }

  // The split read answers from `answers` in order; the last one repeats.
  function serve(answers: (() => Response)[]) {
    let index = 0
    const reads = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/workers')) return json([self])
      return answers[Math.min(index++, answers.length - 1)]()
    })
    vi.stubGlobal('fetch', reads)
    return reads
  }

  const good = () => json(splitState({ jobs: [job()] }))
  const failure = () => new Response('boom', { status: 503 })

  it('publishes the rows of the first round', async () => {
    vi.useFakeTimers()
    serve([good])
    const leave = useSplitState()
    await vi.advanceTimersByTimeAsync(0)
    const view = get(splitView)
    expect(view?.anySplit).toBe(true)
    expect(view?.results.map((r) => r.worker)).toEqual(['worker-1'])
    leave()
  })

  it('is stale after the second failed round, not the first, and keeps the rows', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.UTC(2026, 10, 21, 12, 0, 0))
    serve([good, failure])
    const leave = useSplitState()
    await vi.advanceTimersByTimeAsync(0)
    const goodRoundAt = Date.now()

    await vi.advanceTimersByTimeAsync(SPLIT_POLL_MS)
    expect(get(splitStaleSince)).toBeNull()

    await vi.advanceTimersByTimeAsync(SPLIT_POLL_MS)
    expect(get(splitStaleSince)).toBe(goodRoundAt)
    expect(get(splitView)?.results[0].state.jobs).toHaveLength(1)
    expect(get(splitView)?.unanswered[0]).toEqual({ worker: 'worker-1', reason: 'HTTP 503' })
    leave()
  })

  it('clears the stale sign on the next good round', async () => {
    vi.useFakeTimers()
    serve([good, failure, failure, good])
    const leave = useSplitState()
    await vi.advanceTimersByTimeAsync(SPLIT_POLL_MS * 2)
    expect(get(splitStaleSince)).not.toBeNull()
    await vi.advanceTimersByTimeAsync(SPLIT_POLL_MS)
    expect(get(splitStaleSince)).toBeNull()
    leave()
  })

  it('polls once a minute when no worker splits', async () => {
    vi.useFakeTimers()
    self.split = false
    try {
      const reads = serve([() => json(splitState({ enabled: false }))])
      const leave = useSplitState()
      await vi.advanceTimersByTimeAsync(0)
      const after = reads.mock.calls.length
      await vi.advanceTimersByTimeAsync(SPLIT_ABSENT_POLL_MS - 1)
      expect(reads.mock.calls.length).toBe(after)
      await vi.advanceTimersByTimeAsync(1)
      expect(reads.mock.calls.length).toBeGreaterThan(after)
      expect(get(splitView)?.anySplit).toBe(false)
      leave()
    } finally {
      self.split = true
    }
  })

  it('stops with the last user and forgets the rows', async () => {
    vi.useFakeTimers()
    const reads = serve([good])
    const leave = useSplitState()
    await vi.advanceTimersByTimeAsync(0)
    leave()
    const after = reads.mock.calls.length
    await vi.advanceTimersByTimeAsync(SPLIT_ABSENT_POLL_MS * 2)
    expect(reads.mock.calls.length).toBe(after)
    expect(get(splitView)).toBeNull()
  })
})

describe('workers without the split route', () => {
  it('are listed as not available, not as workers that did not answer', () => {
    const summary = splitSummary(
      [{ worker: 'worker-1', state: splitState({ jobs: [job()] }) }],
      [{ worker: 'worker-2', reason: 'not available on this worker' }],
    )
    expect(summary.unanswered).toEqual([])
    expect(summary.notAvailable).toEqual(['worker-2'])
    expect(summaryText(summary)).not.toContain('did not answer')
  })
})

describe('isSplitState', () => {
  it('accepts a full answer and refuses an empty object', () => {
    expect(isSplitState(splitState({ jobs: [job({ parts: null })] }))).toBe(true)
    expect(isSplitState({})).toBe(false)
    expect(isSplitState(splitState({ jobs: [{} as SplitJob] }))).toBe(false)
  })
})

describe('anyWorkerSplits', () => {
  const peer = (overrides: Partial<WorkerPeer>): WorkerPeer => ({
    worker_name: 'worker-1',
    cluster: 'main',
    url: '',
    is_current: false,
    ip_address: null,
    debug_port: null,
    debug_url: null,
    ...overrides,
  })

  it('is true for a same-cluster peer with split while this worker has it off', () => {
    const workers = [
      peer({ worker_name: 'worker-1', is_current: true, split: false }),
      peer({ worker_name: 'worker-2', url: 'http://w2:8080', split: true }),
    ]
    expect(anyWorkerSplits(workers, [])).toBe(true)
  })

  it('is false for a peer with split in another cluster', () => {
    const workers = [
      peer({ worker_name: 'worker-1', is_current: true, split: false }),
      peer({ worker_name: 'worker-2', cluster: 'other', url: 'http://w2:8080', split: true }),
    ]
    expect(anyWorkerSplits(workers, [])).toBe(false)
  })
})

describe('the shared poll loop with peers', () => {
  afterEach(() => {
    resetSplitForTests()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
  })

  const workers: WorkerPeer[] = [
    {
      worker_name: 'worker-1',
      cluster: 'main',
      url: '',
      is_current: true,
      ip_address: null,
      debug_port: null,
      debug_url: null,
      split: true,
    },
    {
      worker_name: 'worker-2',
      cluster: 'main',
      url: 'http://w2:8080',
      is_current: false,
      ip_address: null,
      debug_port: null,
      debug_url: null,
    },
  ]

  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

  // `own` answers for the page's worker, `peer` for worker-2.
  function serve(own: () => Promise<Response>, peer: () => Promise<Response>) {
    const reads = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/workers')) return json(workers)
      return url.startsWith('http://w2:8080') ? peer() : own()
    })
    vi.stubGlobal('fetch', reads)
    return reads
  }

  it('lists a 404 peer as not available next to an answering worker', async () => {
    vi.useFakeTimers()
    serve(
      async () => json(splitState({ jobs: [job()] })),
      async () => new Response('Not Found', { status: 404 }),
    )
    const leave = useSplitState()
    await vi.advanceTimersByTimeAsync(0)
    const view = get(splitView)
    expect(view?.results.map((r) => r.worker)).toEqual(['worker-1'])
    const summary = splitSummary(view?.results ?? [], view?.unanswered ?? [])
    expect(summary.notAvailable).toEqual(['worker-2'])
    expect(summaryText(summary)).not.toContain('did not answer')
    leave()
  })

  it('is not stale when every worker answers 404', async () => {
    vi.useFakeTimers()
    const notFound = async () => new Response('Not Found', { status: 404 })
    serve(notFound, notFound)
    const leave = useSplitState()
    await vi.advanceTimersByTimeAsync(SPLIT_POLL_MS * 3)
    expect(get(splitStaleSince)).toBeNull()
    expect(get(splitView)?.results).toEqual([])
    leave()
  })

  it('lists a worker with a malformed answer and keeps polling', async () => {
    vi.useFakeTimers()
    const reads = serve(
      async () => json({}),
      async () => json(splitState({ worker: { name: 'worker-2', instance: 'b' } })),
    )
    const leave = useSplitState()
    await vi.advanceTimersByTimeAsync(0)
    expect(get(splitView)?.unanswered).toEqual([
      { worker: 'worker-1', reason: MALFORMED_ANSWER_REASON },
    ])
    expect(get(splitView)?.results.map((r) => r.worker)).toEqual(['worker-2'])
    const after = reads.mock.calls.length
    await vi.advanceTimersByTimeAsync(SPLIT_POLL_MS)
    expect(reads.mock.calls.length).toBeGreaterThan(after)
    leave()
  })

  it('keeps polling when every answer is malformed', async () => {
    vi.useFakeTimers()
    const reads = serve(
      async () => json({}),
      async () => json({}),
    )
    const leave = useSplitState()
    await vi.advanceTimersByTimeAsync(0)
    expect(get(splitView)?.unanswered.map((u) => u.reason)).toEqual([
      MALFORMED_ANSWER_REASON,
      MALFORMED_ANSWER_REASON,
    ])
    // No worker gave a split state, so the slow pace applies.
    const after = reads.mock.calls.length
    await vi.advanceTimersByTimeAsync(SPLIT_ABSENT_POLL_MS)
    expect(reads.mock.calls.length).toBeGreaterThan(after)
    leave()
  })

  it('publishes and schedules nothing when the last user leaves during a round', async () => {
    vi.useFakeTimers()
    let release: (r: Response) => void = () => {}
    const reads = serve(
      () => new Promise<Response>((resolve) => (release = resolve)),
      async () => json(splitState()),
    )
    const leave = useSplitState()
    await vi.advanceTimersByTimeAsync(0)
    leave()
    release(json(splitState({ jobs: [job()] })))
    await vi.advanceTimersByTimeAsync(0)
    expect(get(splitView)).toBeNull()
    const after = reads.mock.calls.length
    await vi.advanceTimersByTimeAsync(SPLIT_ABSENT_POLL_MS * 2)
    expect(reads.mock.calls.length).toBe(after)
  })

  it('polls within one fast tick when a tab hidden at load shows', async () => {
    vi.useFakeTimers()
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    const reads = serve(
      async () => json(splitState({ jobs: [job()] })),
      async () => json(splitState()),
    )
    const leave = useSplitState()
    await vi.advanceTimersByTimeAsync(0)
    expect(reads).not.toHaveBeenCalled()
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(reads).toHaveBeenCalled()
    expect(get(splitView)).not.toBeNull()
    leave()
  })

  it('retries a round skipped by a hidden tab at the fast pace', async () => {
    vi.useFakeTimers()
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    const reads = serve(
      async () => json(splitState({ jobs: [job()] })),
      async () => json(splitState()),
    )
    const leave = useSplitState()
    await vi.advanceTimersByTimeAsync(0)
    // The tab shows without an event; the next fast tick asks.
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    await vi.advanceTimersByTimeAsync(SPLIT_POLL_MS)
    expect(reads).toHaveBeenCalled()
    expect(get(splitView)).not.toBeNull()
    leave()
  })

  it('stops listening for the tab after the last user leaves', async () => {
    vi.useFakeTimers()
    const reads = serve(
      async () => json(splitState()),
      async () => json(splitState()),
    )
    const leave = useSplitState()
    await vi.advanceTimersByTimeAsync(0)
    leave()
    const after = reads.mock.calls.length
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(reads.mock.calls.length).toBe(after)
  })

  it('sends no request while the tab is hidden', async () => {
    vi.useFakeTimers()
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    const reads = serve(
      async () => json(splitState()),
      async () => json(splitState()),
    )
    const leave = useSplitState()
    await vi.advanceTimersByTimeAsync(SPLIT_ABSENT_POLL_MS * 2)
    expect(reads).not.toHaveBeenCalled()
    leave()
  })
})

describe('failed rounds with workers without the route', () => {
  afterEach(() => {
    resetSplitForTests()
    vi.restoreAllMocks()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const workers: WorkerPeer[] = [
    {
      worker_name: 'worker-1',
      cluster: 'main',
      url: '',
      is_current: true,
      ip_address: null,
      debug_port: null,
      debug_url: null,
      split: true,
    },
    {
      worker_name: 'worker-2',
      cluster: 'main',
      url: 'http://w2:8080',
      is_current: false,
      ip_address: null,
      debug_port: null,
      debug_url: null,
    },
  ]

  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

  // A read that never answers and rejects when the fan-out gives up on it.
  const hang = (init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(new DOMException('aborted', 'AbortError')),
      )
    })

  it('fails when one worker times out and the other answers 404, and goes stale', async () => {
    vi.useFakeTimers()
    let ownReads = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('/workers')) return json(workers)
        if (url.startsWith('http://w2:8080')) return new Response('Not Found', { status: 404 })
        ownReads += 1
        return ownReads === 1 ? json(splitState({ jobs: [job()] })) : hang(init)
      }),
    )
    const leave = useSplitState()
    await vi.advanceTimersByTimeAsync(0)
    expect(get(splitView)?.results).toHaveLength(1)

    // Round 2 starts at 5 s and times out at 10 s: the first failed round.
    await vi.advanceTimersByTimeAsync(10_500)
    expect(get(splitStaleSince)).toBeNull()
    expect(get(splitView)?.unanswered).toContainEqual({ worker: 'worker-1', reason: 'timed out' })
    expect(get(splitView)?.results).toHaveLength(1)

    // Round 3 starts at 15 s and times out at 20 s: the second one.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(get(splitStaleSince)).not.toBeNull()
    leave()
  })

  it('counts a round that throws as failed and schedules the next one', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(splitState({ jobs: [job()] }))),
    )
    const workersCall = vi
      .spyOn(api, 'workers')
      .mockResolvedValueOnce(workers.slice(0, 1))
      // Not a list: the round throws when it looks for the current worker.
      .mockResolvedValue(null as unknown as WorkerPeer[])
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const leave = useSplitState()
    await vi.advanceTimersByTimeAsync(0)
    expect(get(splitView)?.results).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(SPLIT_POLL_MS)
    expect(workersCall).toHaveBeenCalledTimes(2)
    expect(get(splitStaleSince)).toBeNull()

    await vi.advanceTimersByTimeAsync(SPLIT_POLL_MS)
    expect(workersCall).toHaveBeenCalledTimes(3)
    expect(get(splitStaleSince)).not.toBeNull()
    expect(get(splitView)?.results).toHaveLength(1)
    leave()
  })
})

describe('the poll loop and the page worker split switch', () => {
  afterEach(() => {
    resetSplitForTests()
    identity.set(null)
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('polls at once when split turns on while the slow timer waits', async () => {
    vi.useFakeTimers()
    const off = splitState({ enabled: false })
    const reads = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/workers')) return new Response('[]', { status: 200 })
      return new Response(JSON.stringify(off), { status: 200 })
    })
    vi.stubGlobal('fetch', reads)
    const leave = useSplitState()
    await vi.advanceTimersByTimeAsync(0)
    const after = reads.mock.calls.length
    identity.set({
      capabilities: {
        split: {
          enabled: true,
          parts_topic: 'p',
          results_topic: 'r',
          parts_partition_base: 1000000,
        },
      },
    } as never)
    await vi.advanceTimersByTimeAsync(0)
    expect(reads.mock.calls.length).toBeGreaterThan(after)
    leave()
  })
})
