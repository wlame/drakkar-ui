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
import { fmtTime } from './format'
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
 * One plain sentence per outcome of `last_request`. A value missing here (a
 * newer worker) is shown as it is, see outcomeText.
 */
export const OUTCOME_SENTENCES: Record<string, string> = {
  detached: 'The worker left its consumer group.',
  attached: 'The worker joined its consumer group again.',
  not_running: 'The Kafka source has not started yet. Try again in a moment.',
  stopping: 'The worker is stopping.',
  disabled: 'Detach is off on this worker (sources.kafka.detach.enabled).',
  inside_pipeline_hook: 'The handler asked from inside a pipeline hook, which is not allowed.',
  already_detached: 'An operator detach is active. Attach the worker first.',
  cooldown: 'The worker attached a short time ago. Wait for the cooldown to end.',
  too_few_workers: 'Too few workers of this group would stay attached.',
  budget_full:
    'The limit of detached workers in this group is reached. Attach another worker first, or wait.',
  store_unavailable: 'The autodiscover store did not answer. Try again later.',
  leave_failed: 'The worker did not leave its group in time. It stays attached.',
  held_by_operator: 'An operator detached this worker. Only an operator can attach it.',
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

/** "5 min" / "15 min" / "1 h" — the labels of the durations. */
export function fmtDetachDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} s`
  if (seconds < 3600 || seconds % 3600 !== 0) return `${Math.round(seconds / 60)} min`
  return `${seconds / 3600} h`
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

/** The delay before the next poll. */
export function nextPollDelayMs(s: DetachState | null, fastUntilMs: number, nowMs: number): number {
  return isTransitional(s) || nowMs < fastUntilMs ? DETACH_FAST_POLL_MS : DETACH_SLOW_POLL_MS
}

/** "1:05" or "1:02:05"; never below zero. */
export function fmtTimeLeft(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = String(total % 60).padStart(2, '0')
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`
}

/** "14:02:11 UTC" — an epoch-milliseconds time, in UTC like the rest of the UI. */
export function fmtUtcTimeMs(ms: number): string {
  return `${fmtTime(ms / 1000)} UTC`
}

/** The sentence for a request that did not reach the worker. */
export const NETWORK_ERROR_TEXT = 'The worker did not answer. Check the connection and try again.'

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

let users = 0
let timer: ReturnType<typeof setTimeout> | undefined
let fastUntilMs = 0
let current: DetachState | null = null
// Bumped by every start and stop, so a fetch that lands after a stop or a
// restart does not schedule a second loop.
let generation = 0
// Bumped by every POST answer: a GET that started before it carries an older
// state and is dropped.
let requestSeq = 0

function publish(value: DetachState | null) {
  current = value
  detachState.set(value)
}

function schedule(gen: number) {
  if (gen !== generation) return
  clearTimeout(timer)
  timer = setTimeout(() => void poll(gen), nextPollDelayMs(current, fastUntilMs, Date.now()))
}

// One poll: a 404 or a worker with the feature off ends the loop (nothing will
// change without a restart); any other failure keeps the last state, so a
// short outage does not hide the banner of a detached worker. A hidden tab
// skips the request and keeps the loop alive.
async function poll(gen: number) {
  if (gen !== generation) return
  if (!isHidden()) {
    const seqAtStart = requestSeq
    let value: DetachState | null
    try {
      value = await api.getDetachState()
    } catch {
      schedule(gen)
      return
    }
    if (gen !== generation) return
    if (seqAtStart !== requestSeq) {
      // A POST answered while this read was in flight; its body is newer.
      schedule(gen)
      return
    }
    publish(value)
    if (value === null || !value.enabled) return
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
    publish(null)
  }
}

// After a request the answer is the new state, and the loop runs fast for a
// few seconds so the outcome shows soon. A request with no loop running (no
// user) only publishes.
function afterRequest(value: DetachState) {
  requestSeq += 1
  publish(value)
  fastUntilMs = Date.now() + DETACH_FAST_AFTER_REQUEST_MS
  if (users > 0) schedule(generation)
}

/** Stop the loop and forget every user; for tests, between cases. */
export function resetDetachForTests(): void {
  users = 0
  generation += 1
  clearTimeout(timer)
  timer = undefined
  fastUntilMs = 0
  requestSeq = 0
  publish(null)
}

/** POST /debug/detach, then the fast pace. Throws the HTTP error. */
export async function requestDetach(durationSeconds: number, reason: string): Promise<void> {
  afterRequest(await api.postDetach(durationSeconds, reason))
}

/** POST /debug/attach, then the fast pace. Throws the HTTP error. */
export async function requestAttach(): Promise<void> {
  afterRequest(await api.postAttach())
}
