// Split jobs (contract v1.34): the Dashboard panel reads
// GET /api/v1/debug/split from every worker of the cluster and shows the open
// jobs, their progress and what looks stuck. The data lives in one store with
// one poll loop, shared by reference count like the detach state: the first
// user starts the loop, the last one stops it.
//
// The pure helpers (merging, summary, health marks, pace, texts) are here too,
// so the panel only draws.

import { get, writable } from 'svelte/store'
import { api } from './api'
import { isSplitOn } from './capabilities'
import { sameClusterPeers } from './cluster'
import { NOT_AVAILABLE_REASON, fanOut, fanOutTargets, type Unreachable } from './fanout'
import { fmtUptime } from './format'
import { traceLabelHash } from './splitLabels'
import { isHidden } from './visibility'
import type { SplitJob, SplitState, WorkerPeer } from './types'

/** Poll pace while a worker of the cluster splits. */
export const SPLIT_POLL_MS = 5_000
/** Poll pace while no worker splits: slow, but a worker that starts splitting shows up. */
export const SPLIT_ABSENT_POLL_MS = 60_000
/** Failed rounds in a row before the rows count as stale; one blip is not. */
export const SPLIT_STALE_AFTER_FAILED_ROUNDS = 2
/** A partition restoring for longer than this is marked. */
export const RESTORING_LIMIT_SECONDS = 120
/** A job is near its timeout with less time left than this share of the timeout... */
export const NEAR_TIMEOUT_SHARE = 0.1
/** ...or than this many seconds, whichever is larger... */
export const NEAR_TIMEOUT_MIN_SECONDS = 300
/** ...but never more than this share of the timeout. */
export const NEAR_TIMEOUT_MAX_SHARE = 0.25
/** The label the backend stamps on every task of a split job. */
export const SPLIT_JOB_LABEL = 'split_job'
/** The reason of a worker whose answer is not a split state (a proxy page, say). */
export const MALFORMED_ANSWER_REASON = 'the answer cannot be read'

/** One worker's answer. `base` is its origin ('' for the page's own worker). */
export interface SplitWorkerState {
  worker: string
  base: string
  state: SplitState
}

/**
 * One open job of the cluster, with every worker that reports it.
 * `reportedBy` is the worker whose report supplies the row's numbers.
 */
export type SplitRow = SplitJob & { owners: string[]; reportedBy: string }

export type SplitHealth = 'failed_parts' | 'near_timeout'

export interface SplitSummary {
  // Open jobs of the cluster, counted from each worker's `jobs_total`.
  openJobs: number
  // Job rows shown; less than `openJobs` when a worker cut its list.
  shownJobs: number
  partsLeft: number
  oldestAgeSeconds: number | null
  restoring: { worker: string; partition: number; seconds: number }[]
  // Workers that did not answer, or whose answer cannot be read.
  unanswered: Unreachable[]
  // Workers without the split route (a 404: an older release or another backend).
  notAvailable: string[]
  writeFailures: { worker: string; count: number }[]
}

/** What the panel draws: the last good answers and who did not answer. */
export interface SplitView {
  results: SplitWorkerState[]
  unanswered: Unreachable[]
  // A worker of the cluster splits (its card or its answer says so).
  anySplit: boolean
  // At least one round of this loop succeeded; until then there is no answer.
  answered: boolean
}

/** The delay before the next round. */
export function nextSplitPollDelayMs(anySplit: boolean): number {
  return anySplit ? SPLIT_POLL_MS : SPLIT_ABSENT_POLL_MS
}

/** The job's label value, `<partition>:<offset>`. */
export function jobKey(job: Pick<SplitJob, 'partition' | 'offset'>): string {
  return `${job.partition}:${job.offset}`
}

/** "7:500", or "7:500 (attempt 2)" for a later attempt. */
export function jobLabel(job: SplitJob): string {
  const key = jobKey(job)
  return job.attempt > 1 ? `${key} (attempt ${job.attempt})` : key
}

/** The Trace tab with the label search of the job filled in. */
export function splitTraceHref(job: Pick<SplitJob, 'partition' | 'offset'>): string {
  return `/debug${traceLabelHash(SPLIT_JOB_LABEL, jobKey(job))}`
}

/**
 * One row per job, oldest `opened_at` first. Two workers that report the same
 * job (a short overlap in a rebalance) give one row naming both; the row shows
 * the report with the most results.
 */
// The later attempt wins (an owner that took the job over knows it), then the
// report with more results.
function isNewerReport(job: SplitJob, known: SplitJob): boolean {
  if (job.attempt !== known.attempt) return job.attempt > known.attempt
  return job.received > known.received
}

export function mergeSplitJobs(results: { worker: string; state: SplitState }[]): SplitRow[] {
  const rows = new Map<string, SplitRow>()
  for (const { worker, state } of results) {
    for (const job of state.jobs) {
      const key = jobKey(job)
      const known = rows.get(key)
      if (!known) {
        rows.set(key, { ...job, owners: [worker], reportedBy: worker })
        continue
      }
      const owners = [...known.owners, worker]
      rows.set(
        key,
        isNewerReport(job, known) ? { ...job, owners, reportedBy: worker } : { ...known, owners },
      )
    }
  }
  return [...rows.values()]
    .map((row) => ({ ...row, owners: [...new Set(row.owners)].sort() }))
    .sort(
      (a, b) =>
        a.opened_at.localeCompare(b.opened_at) || a.partition - b.partition || a.offset - b.offset,
    )
}

/** True for a worker that answered 404: it has no split route. */
export function isNotAvailable(entry: Unreachable): boolean {
  return entry.reason === NOT_AVAILABLE_REASON
}

/** The numbers of the summary line and the worker-level health marks. */
export function splitSummary(
  results: { worker: string; state: SplitState }[],
  unreachable: Unreachable[],
): SplitSummary {
  const rows = mergeSplitJobs(results)
  const partsLeft = rows.reduce(
    (sum, row) => (row.parts === null ? sum : sum + Math.max(0, row.parts - row.received)),
    0,
  )
  const restoring = results.flatMap(({ worker, state }) =>
    state.partitions
      .filter((p) => p.state === 'restoring')
      .map((p) => ({ worker, partition: p.partition, seconds: p.state_seconds })),
  )
  const writeFailures = results
    .filter(({ state }) => state.result_write_failures_total > 0)
    .map(({ worker, state }) => ({ worker, count: state.result_write_failures_total }))
  // A worker answers at most `limit` jobs; the rest are counted, not shown.
  const cut = results.reduce(
    (sum, { state }) => sum + Math.max(0, state.jobs_total - state.jobs.length),
    0,
  )
  return {
    openJobs: rows.length + cut,
    shownJobs: rows.length,
    partsLeft,
    oldestAgeSeconds: rows.length ? Math.max(...rows.map((r) => r.age_seconds)) : null,
    restoring,
    unanswered: unreachable.filter((u) => !isNotAvailable(u)),
    notAvailable: unreachable.filter(isNotAvailable).map((u) => u.worker),
    writeFailures,
  }
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

/** "2 open jobs · 60 parts left · oldest 10m 0s · 1 restoring partition · 1 worker did not answer". */
export function summaryText(summary: SplitSummary): string {
  const pieces = [
    plural(summary.openJobs, 'open job', 'open jobs'),
    ...(summary.shownJobs < summary.openJobs
      ? [`showing ${summary.shownJobs} of ${summary.openJobs}`]
      : []),
    `${summary.partsLeft} parts left`,
  ]
  if (summary.oldestAgeSeconds !== null)
    pieces.push(`oldest ${fmtUptime(summary.oldestAgeSeconds)}`)
  if (summary.restoring.length) {
    pieces.push(plural(summary.restoring.length, 'restoring partition', 'restoring partitions'))
  }
  if (summary.unanswered.length) {
    pieces.push(`${plural(summary.unanswered.length, 'worker', 'workers')} did not answer`)
  }
  return pieces.join(' · ')
}

/**
 * Seconds before the job's timeout, or null when no timeout applies. Read from
 * the server's values only (the time between the open and the timeout, minus
 * the age at the answer), so a browser clock that is off changes nothing.
 */
export function timeLeftSeconds(job: SplitJob): number | null {
  if (!job.timeout_at) return null
  const at = Date.parse(job.timeout_at)
  const opened = Date.parse(job.opened_at)
  if (Number.isNaN(at) || Number.isNaN(opened)) return null
  return (at - opened) / 1000 - job.age_seconds
}

/** The timeout that `timeout_at` stands for, in seconds; null when unknown. */
function timeoutSeconds(job: SplitJob, settings: SplitState['settings']): number | null {
  if (!settings) return null
  if (job.timeout_kind === 'job') return settings.job_timeout_seconds
  if (job.timeout_kind === 'idle') return settings.idle_timeout_seconds
  // A kind this release does not know: no timeout, so no mark.
  return null
}

/**
 * The time left, in seconds, below which a job with this timeout is near it:
 * min(max(10 % of the timeout, 300 s), 25 % of the timeout), the threshold of
 * the diagnose rule `split-job-near-timeout`.
 */
export function nearTimeoutThreshold(timeoutSeconds: number): number {
  const floored = Math.max(NEAR_TIMEOUT_SHARE * timeoutSeconds, NEAR_TIMEOUT_MIN_SECONDS)
  return Math.min(floored, NEAR_TIMEOUT_MAX_SHARE * timeoutSeconds)
}

/** The health marks of a job: failed parts, and less time left than the near-timeout threshold. */
export function jobHealth(row: SplitRow, settings: SplitState['settings']): SplitHealth[] {
  const marks: SplitHealth[] = []
  if (row.failed > 0) marks.push('failed_parts')
  const left = timeLeftSeconds(row)
  const timeout = timeoutSeconds(row, settings)
  if (left !== null && timeout !== null && left < nearTimeoutThreshold(timeout)) {
    marks.push('near_timeout')
  }
  return marks
}

/** True for a partition restoring for more than 120 s. */
export function restoringTooLong(seconds: number): boolean {
  return seconds > RESTORING_LIMIT_SECONDS
}

/** Whole percent of the parts with a result; null before the split is done. */
export function progressPercent(job: SplitJob): number | null {
  if (job.parts === null) return null
  if (job.parts <= 0) return 100
  return Math.min(100, Math.floor((job.received / job.parts) * 100))
}

/** The answer that supplies the row's numbers (for its partition base, settings and topic). */
export function ownerState(
  row: SplitRow,
  results: SplitWorkerState[],
): SplitWorkerState | undefined {
  return results.find((r) => r.worker === row.reportedBy)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSplitJob(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.partition === 'number' &&
    typeof value.offset === 'number' &&
    typeof value.attempt === 'number' &&
    typeof value.received === 'number' &&
    typeof value.failed === 'number' &&
    typeof value.age_seconds === 'number' &&
    typeof value.opened_at === 'string' &&
    (value.parts === null || typeof value.parts === 'number')
  )
}

function isSplitPartition(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.partition === 'number' &&
    typeof value.state === 'string' &&
    typeof value.state_seconds === 'number'
  )
}

/**
 * True when an answer has the fields the panel reads. Anything else (a proxy
 * page, an empty object) counts as a worker that did not answer.
 */
export function isSplitState(value: unknown): value is SplitState {
  return (
    isRecord(value) &&
    typeof value.enabled === 'boolean' &&
    isRecord(value.worker) &&
    typeof value.worker.name === 'string' &&
    typeof value.result_write_failures_total === 'number' &&
    Array.isArray(value.jobs) &&
    value.jobs.every(isSplitJob) &&
    Array.isArray(value.partitions) &&
    value.partitions.every(isSplitPartition)
  )
}

/** True when a worker of the cluster splits, by its card or by its answer. */
export function anyWorkerSplits(workers: WorkerPeer[], results: SplitWorkerState[]): boolean {
  const current = workers.filter((w) => w.is_current)
  const cluster = [...current, ...sameClusterPeers(workers)]
  return cluster.some((w) => w.split === true) || results.some((r) => r.state.enabled)
}

/** The panel's data; null before the first round and after the loop stops. */
export const splitView = writable<SplitView | null>(null)

/**
 * Epoch milliseconds of the last good round while no worker answers (two
 * failed rounds in a row); null otherwise. The last rows stay shown.
 */
export const splitStaleSince = writable<number | null>(null)

let users = 0
let lastGoodRoundMs: number | null = null
let failedRounds = 0
let anySplit = false
let timer: ReturnType<typeof setTimeout> | undefined
// True while the pending timer waits the slow pace, so a worker that starts
// splitting is asked at once instead of after up to a minute.
let timerIsSlow = false
// True while a round runs; an extra poll then waits for its schedule.
let roundInFlight = false
let stopWatching: (() => void) | undefined
// Bumped by every start and stop, so a round that lands after a stop or a
// restart does not schedule a second loop.
let generation = 0

// The workers list; on a failure the page's own worker alone.
async function readWorkers(): Promise<WorkerPeer[]> {
  try {
    return await api.workers()
  } catch {
    return []
  }
}

// A failed round: the last rows stay, with the new list of workers that did
// not answer; the second failed round in a row marks the rows stale.
function roundFailed(unanswered: Unreachable[]) {
  failedRounds += 1
  const last = get(splitView)
  splitView.set({
    results: last?.results ?? [],
    unanswered,
    anySplit: last?.anySplit ?? false,
    answered: last?.answered ?? false,
  })
  if (failedRounds >= SPLIT_STALE_AFTER_FAILED_ROUNDS && lastGoodRoundMs !== null) {
    splitStaleSince.set(lastGoodRoundMs)
  }
}

// True when every worker of the round answered 404: a cluster without the
// route is a good round with no rows. One timeout, unreachable worker or
// unreadable answer among them makes it a failed round.
function everyWorkerLacksTheRoute(unanswered: Unreachable[]): boolean {
  return unanswered.length > 0 && unanswered.every(isNotAvailable)
}

// One round over the cluster. A worker whose answer cannot be read is listed
// with a reason. The round fails when no worker answered with a split state,
// unless every worker answered 404.
async function round(gen: number): Promise<void> {
  const workers = await readWorkers()
  if (gen !== generation) return
  const { targets, unreachable } = fanOutTargets(workers)
  const answer = await fanOut<unknown>(targets, (t, signal) => api.getSplitStateAt(t.base, signal))
  if (gen !== generation) return
  const results: SplitWorkerState[] = []
  const unanswered = [...unreachable, ...answer.unreachable]
  for (const r of answer.results) {
    if (!isSplitState(r.value)) {
      unanswered.push({ worker: r.worker, reason: MALFORMED_ANSWER_REASON })
      continue
    }
    results.push({ worker: r.worker || r.value.worker.name, base: r.base, state: r.value })
  }
  if (results.length === 0 && !everyWorkerLacksTheRoute(unanswered)) {
    roundFailed(unanswered)
    return
  }
  anySplit = anyWorkerSplits(workers, results)
  lastGoodRoundMs = Date.now()
  failedRounds = 0
  splitStaleSince.set(null)
  splitView.set({ results, unanswered, anySplit, answered: true })
}

// A skipped round (a hidden tab) is tried again at the fast pace, so the
// panel fills soon after the tab shows, whatever the cluster does.
function schedule(gen: number, skipped: boolean) {
  if (gen !== generation) return
  clearTimeout(timer)
  const delay = skipped ? SPLIT_POLL_MS : nextSplitPollDelayMs(anySplit || get(isSplitOn))
  timerIsSlow = delay > SPLIT_POLL_MS
  timer = setTimeout(() => void poll(gen), delay)
}

// A hidden tab skips the round and keeps the loop alive.
async function poll(gen: number) {
  if (gen !== generation) return
  const skipped = isHidden()
  roundInFlight = true
  try {
    if (!skipped) await round(gen)
  } catch (error) {
    // An unexpected error must not end the loop: the round counts as failed,
    // and the next one is scheduled as usual.
    console.warn('split jobs round failed', error)
    if (gen === generation) roundFailed(get(splitView)?.unanswered ?? [])
  } finally {
    if (gen === generation) roundInFlight = false
    schedule(gen, skipped)
  }
}

// Poll at once in place of the pending timer, unless a round already runs.
function pollNow() {
  if (roundInFlight) return
  clearTimeout(timer)
  void poll(generation)
}

function onVisibilityChange() {
  if (!isHidden()) pollNow()
}

// Watch the tab and the page's own split switch while the loop runs.
function watchTriggers(): () => void {
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange)
  }
  const unsubscribe = isSplitOn.subscribe((on) => {
    if (on && timerIsSlow) pollNow()
  })
  return () => {
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
    unsubscribe()
  }
}

function forget() {
  generation += 1
  clearTimeout(timer)
  timer = undefined
  timerIsSlow = false
  roundInFlight = false
  stopWatching?.()
  stopWatching = undefined
  lastGoodRoundMs = null
  failedRounds = 0
  anySplit = false
  splitStaleSince.set(null)
  splitView.set(null)
}

/**
 * Join the shared poll loop; returns the function that leaves it. The first
 * user starts the loop with an immediate round; the last one stops it.
 */
export function useSplitState(): () => void {
  users += 1
  if (users === 1) {
    generation += 1
    stopWatching = watchTriggers()
    void poll(generation)
  }
  let left = false
  return () => {
    if (left) return
    left = true
    users -= 1
    if (users > 0) return
    forget()
  }
}

/** Stop the loop and forget every user; for tests, between cases. */
export function resetSplitForTests(): void {
  users = 0
  forget()
}
