// Detach (contract v1.33): the worker leaves its Kafka consumer group for a
// bounded time and joins it again. The state is worker-level and two places
// show it — the banner on every page (App.svelte) and the control on the Live
// page — so it lives in one store with one poll loop, shared by reference
// count: the first user starts the loop, the last one stops it.
//
// The pure helpers (presets, sentences, pace, visibility, time text) are here
// too, so the components only draw.

import { writable } from 'svelte/store'
import { api, HttpError } from './api'
import { fmtDateTimeMs, fmtTime } from './format'
import { isHidden } from './visibility'
import type { DetachState } from './types'

/** The preset durations of the Detach form: 5 min, 15 min, 1 h. */
export const DETACH_PRESETS_SECONDS = [300, 900, 3600] as const

/** The worker cuts a longer reason; the field stops at the same length. */
export const DETACH_REASON_MAX_CHARS = 200

/** Poll pace during a transition and for a short time after a request. */
export const DETACH_FAST_POLL_MS = 1_000
/** Poll pace otherwise; the same pace the consume-pause control uses. */
export const DETACH_SLOW_POLL_MS = 5_000
/** How long the fast pace lasts after a request of this page. */
export const DETACH_FAST_AFTER_REQUEST_MS = 5_000
/**
 * Poll pace while the worker has no detach feature (a 404, or `enabled`
 * false): slow, but a worker restarted with the feature on shows the control
 * without a page reload.
 */
export const DETACH_ABSENT_POLL_MS = 60_000
/**
 * How long the control waits after a 202 answer for a read that shows the
 * request. The 202 body is the state from before the request, so only a
 * later read shows it.
 */
export const DETACH_WAIT_LIMIT_MS = 30_000

/**
 * One plain sentence per outcome of `last_request`. A value missing here (a
 * newer worker) is shown as it is, see outcomeText.
 */
export const OUTCOME_SENTENCES: Record<string, string> = {
  detached: 'The worker left its consumer group.',
  attached: 'The worker joined its consumer group again.',
  not_running:
    'The Kafka source has not finished its first poll, or the worker has not started. Try again in a moment.',
  stopping: 'The worker is stopping.',
  disabled:
    'Detach is off on this worker (sources.kafka.detach.enabled), or it has no Kafka source.',
  inside_pipeline_hook:
    "The handler asked from code that runs as part of a partition's work, which is not allowed. Nothing changed.",
  already_detached:
    'The handler asked to detach, but an operator detach is active. Nothing changed.',
  cooldown:
    'The handler asked too soon after the last return to the group. Nothing changed; the cooldown has to end first.',
  too_few_workers: 'Too few workers of this group would stay attached.',
  budget_full:
    'The limit of detached workers in this group is reached. Attach another worker first, or wait.',
  store_unavailable:
    'The autodiscover store did not answer, or the slot was lost during the leave. The worker did not detach. Try again later.',
  leave_failed:
    'The worker could not leave its group in time. It returns to the group and may show attaching for a moment.',
  held_by_operator:
    'The handler asked to attach, but an operator detached this worker. Only an operator, the deadline or a safety rule ends it.',
  join_failed: 'The worker has not joined its group again yet. It tries again every 5 seconds.',
}

const SUCCESS_OUTCOMES = new Set(['detached', 'attached'])

/** The sentence of an outcome, or the raw value when it is not known. */
export function outcomeText(outcome: string): string {
  return OUTCOME_SENTENCES[outcome] ?? outcome
}

/** True for every outcome that is not a success, an unknown one included. */
export function isRefusal(outcome: string): boolean {
  return !SUCCESS_OUTCOMES.has(outcome)
}

/**
 * The durations the form offers: the presets up to the maximum, or the
 * maximum alone when no preset fits.
 */
export function detachChoices(maxDurationSeconds: number): number[] {
  const within = DETACH_PRESETS_SECONDS.filter((s) => s <= maxDurationSeconds)
  return within.length ? [...within] : [maxDurationSeconds]
}

/** "45 s" / "1 min 30 s" / "15 min" / "1 h" — the labels of the durations. */
export function fmtDetachDuration(seconds: number): string {
  const whole = Math.round(seconds)
  if (whole < 60) return `${whole} s`
  if (whole % 3600 === 0) return `${whole / 3600} h`
  const rest = whole % 60
  return `${Math.floor(whole / 60)} min${rest ? ` ${rest} s` : ''}`
}

/** The disabled button of the control in a state other than attached or detached. */
const STATE_BUTTON_TEXT: Record<string, string> = {
  detaching: 'Detaching…',
  attaching: 'Attaching…',
}

/** The quiet line of the banner in a state other than attached or detached. */
const STATE_LINE_TEXT: Record<string, string> = {
  detaching: 'Detaching from the consumer group…',
  attaching: 'Attaching to the consumer group…',
}

/** The control's text for a state; an unknown value is shown as it is. */
export function detachStateText(state: string): string {
  return STATE_BUTTON_TEXT[state] ?? `State: ${state}`
}

/** The banner's line for a state; an unknown value is shown as it is. */
export function detachStateLine(state: string): string {
  return STATE_LINE_TEXT[state] ?? `Detach state: ${state}`
}

/** What the control saw when it sent a request: the state and the time of last_request. */
export interface SentRequest {
  state: string
  lastRequestAtMs: number | null
}

/** The view to compare later reads with. */
export function sentRequestFrom(s: DetachState | null): SentRequest {
  return { state: s?.state ?? '', lastRequestAtMs: s?.last_request?.at_ms ?? null }
}

/**
 * True when a read shows the request: the state moved, or last_request is
 * newer than the one seen when the request was sent.
 */
export function requestShown(sent: SentRequest, s: DetachState | null): boolean {
  if (!s) return false
  if (s.state !== sent.state) return true
  const at = s.last_request?.at_ms ?? null
  return at !== null && (sent.lastRequestAtMs === null || at > sent.lastRequestAtMs)
}

/** The control shows when the feature and the UI switch are both on. */
export function controlVisible(s: DetachState | null): boolean {
  return s != null && s.enabled && s.ui_enabled
}

/**
 * The banner shows for every state but `attached`. It follows `enabled`
 * only: `ui_enabled` gates the buttons, and a handler detach is worth seeing
 * on a worker whose operator buttons are off.
 */
export function bannerVisible(s: DetachState | null): boolean {
  return s != null && s.enabled && s.state !== 'attached'
}

/** True while the worker leaves or joins its group. */
export function isTransitional(s: DetachState | null): boolean {
  return s?.state === 'detaching' || s?.state === 'attaching'
}

/** What decides the pace of the next poll. */
export interface PollPaceInput {
  state: DetachState | null
  // The last read was a 404, or the feature is off.
  absent: boolean
  // Failed reads in a row (not 404).
  failedReads: number
  fastUntilMs: number
  nowMs: number
}

/** The delay before the next poll. */
export function nextPollDelayMs(input: PollPaceInput): number {
  if (input.absent) return DETACH_ABSENT_POLL_MS
  // A worker that does not answer is not asked every second.
  if (input.failedReads >= DETACH_STALE_AFTER_FAILED_READS) return DETACH_SLOW_POLL_MS
  if (isTransitional(input.state) || input.nowMs < input.fastUntilMs) return DETACH_FAST_POLL_MS
  return DETACH_SLOW_POLL_MS
}

/** "1:05" or "1:02:05"; never below zero. */
export function fmtTimeLeft(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = String(total % 60).padStart(2, '0')
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`
}

/**
 * "14:02:11 UTC" — an epoch-milliseconds time, in UTC like the rest of the
 * UI; "2026-11-21 09:30:00 UTC" when it is not on the current UTC day (a
 * detach can last days).
 */
export function fmtUtcTimeMs(ms: number, nowMs: number = Date.now()): string {
  const day = (t: number) => new Date(t).toISOString().slice(0, 10)
  if (day(ms) === day(nowMs)) return `${fmtTime(ms / 1000)} UTC`
  return `${fmtDateTimeMs(ms)} UTC`
}

/** The sentence for a request that did not reach the worker. */
export const NETWORK_ERROR_TEXT = 'The worker did not answer. Check the connection and try again.'

/**
 * Sentences of the UI for some statuses, before any detail of the answer. A
 * 503 request was not run, or it may have started just now: the state tells.
 */
const STATUS_SENTENCES: Record<number, string> = {
  503: 'The worker did not answer in time. Check the state before you ask again.',
}

interface ValidationItem {
  msg?: unknown
}

/**
 * The plain message of a failed POST: the `detail` of the answer as it is
 * (a 403 hint), the joined `msg` fields of a validation answer (422), the
 * status alone for an answer without `detail`, and one sentence for a
 * request that got no answer.
 */
export function requestErrorText(error: unknown): string {
  if (!(error instanceof HttpError)) return NETWORK_ERROR_TEXT
  const fixed = STATUS_SENTENCES[error.status]
  if (fixed) return fixed
  let detail: unknown
  try {
    detail = (JSON.parse(error.body) as { detail?: unknown }).detail
  } catch {
    detail = undefined
  }
  if (typeof detail === 'string' && detail) return detail
  if (Array.isArray(detail)) {
    const messages = detail
      .map((item: ValidationItem) => (typeof item?.msg === 'string' ? item.msg : ''))
      .filter(Boolean)
    if (messages.length) return messages.join('; ')
  }
  return `The worker answered HTTP ${error.status}.`
}

/** The worker's detach state; null before the first answer and on an older worker. */
export const detachState = writable<DetachState | null>(null)

/**
 * Epoch milliseconds of the last good read while the worker does not answer
 * (two failed reads in a row); null otherwise. The last state stays shown,
 * and this says how old it is.
 */
export const detachStaleSince = writable<number | null>(null)

/** Failed reads in a row before the state counts as stale; one blip is not. */
export const DETACH_STALE_AFTER_FAILED_READS = 2

let users = 0
let lastGoodReadMs: number | null = null
let failedReads = 0
let absent = false
let timer: ReturnType<typeof setTimeout> | undefined
let fastUntilMs = 0
let current: DetachState | null = null
// Bumped by every start and stop, so a fetch that lands after a stop or a
// restart does not schedule a second loop.
let generation = 0

function publish(value: DetachState | null) {
  current = value
  detachState.set(value)
}

// A good read: the state is current again.
function readSucceeded() {
  lastGoodReadMs = Date.now()
  failedReads = 0
  detachStaleSince.set(null)
}

// A failed read (not a 404): the second one in a row marks the state stale.
// Without any good read there is no state to mark.
function readFailed() {
  failedReads += 1
  if (failedReads >= DETACH_STALE_AFTER_FAILED_READS && lastGoodReadMs !== null) {
    detachStaleSince.set(lastGoodReadMs)
  }
}

function forgetReads() {
  lastGoodReadMs = null
  failedReads = 0
  detachStaleSince.set(null)
}

function schedule(gen: number) {
  if (gen !== generation) return
  clearTimeout(timer)
  const delay = nextPollDelayMs({
    state: current,
    absent,
    failedReads,
    fastUntilMs,
    nowMs: Date.now(),
  })
  timer = setTimeout(() => void poll(gen), delay)
}

// One poll: a 404 or a worker with the feature off hides the feature and
// checks again once a minute; any other failure keeps the last state, so a
// short outage does not hide the banner of a detached worker. A hidden tab
// skips the request and keeps the loop alive.
async function poll(gen: number) {
  if (gen !== generation) return
  if (!isHidden()) {
    let value: DetachState | null
    try {
      value = await api.getDetachState()
    } catch {
      if (gen !== generation) return
      readFailed()
      schedule(gen)
      return
    }
    if (gen !== generation) return
    readSucceeded()
    publish(value)
    absent = value === null || !value.enabled
  }
  schedule(gen)
}

/**
 * Join the shared poll loop; returns the function that leaves it. The first
 * user starts the loop with an immediate read; the last one stops it.
 */
export function useDetachState(): () => void {
  users += 1
  if (users === 1) {
    generation += 1
    void poll(generation)
  }
  let left = false
  return () => {
    if (left) return
    left = true
    users -= 1
    if (users > 0) return
    generation += 1
    clearTimeout(timer)
    timer = undefined
    fastUntilMs = 0
    absent = false
    forgetReads()
    publish(null)
  }
}

// After a request the loop runs fast for a few seconds, so the change shows
// soon. The 202 body is not published: it is the state from before the
// request, and a read that started after the POST may already be newer.
function afterRequest() {
  fastUntilMs = Date.now() + DETACH_FAST_AFTER_REQUEST_MS
  if (users > 0) schedule(generation)
}

/** Read the state at once (after a failed request: it may have started). */
export function refreshDetachNow(): void {
  fastUntilMs = Date.now() + DETACH_FAST_AFTER_REQUEST_MS
  if (users === 0) return
  clearTimeout(timer)
  timer = setTimeout(() => void poll(generation), 0)
}

/** Stop the loop and forget every user; for tests, between cases. */
export function resetDetachForTests(): void {
  users = 0
  generation += 1
  clearTimeout(timer)
  timer = undefined
  fastUntilMs = 0
  absent = false
  forgetReads()
  publish(null)
}

/** POST /debug/detach, then the fast pace. Throws the HTTP error. */
export async function requestDetach(durationSeconds: number, reason: string): Promise<void> {
  await api.postDetach(durationSeconds, reason)
  afterRequest()
}

/** POST /debug/attach, then the fast pace. Throws the HTTP error. */
export async function requestAttach(): Promise<void> {
  await api.postAttach()
  afterRequest()
}
