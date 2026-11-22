// Split jobs panel helpers (contract v1.34): merging the jobs the workers of a
// cluster report, the summary line, the health marks, the poll pace and the
// shared poll loop with its stale sign.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'
import {
  SPLIT_ABSENT_POLL_MS,
  SPLIT_POLL_MS,
  jobHealth,
  jobLabel,
  mergeSplitJobs,
  nextSplitPollDelayMs,
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
      writeFailures: [],
    })
    expect(text).toBe(
      '2 open jobs · 60 parts left · oldest 10m 0s · 1 restoring partition · 1 worker did not answer',
    )
  })

  it('says one open job and no oldest age when there are none', () => {
    expect(
      summaryText({
        openJobs: 0,
        partsLeft: 0,
        oldestAgeSeconds: null,
        restoring: [],
        unanswered: [],
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
  const row = (overrides: Partial<SplitJob>) => ({ ...job(overrides), owners: ['worker-1'] })

  it('marks a job with 9 % of its timeout left, not one with 11 %', () => {
    const day = 86400
    expect(
      jobHealth(row({ timeout_at: at(day * 0.09), timeout_kind: 'job' }), settings(day), now),
    ).toEqual(['near_timeout'])
    expect(
      jobHealth(row({ timeout_at: at(day * 0.11), timeout_kind: 'job' }), settings(day), now),
    ).toEqual([])
  })

  it('marks a job with 299 s left, not one with 301 s', () => {
    expect(
      jobHealth(row({ timeout_at: at(299), timeout_kind: 'job' }), settings(1000), now),
    ).toEqual(['near_timeout'])
    expect(
      jobHealth(row({ timeout_at: at(301), timeout_kind: 'job' }), settings(1000), now),
    ).toEqual([])
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
