// Task cost / speed / throughput (contract v1.16): parsing the per-second
// `throughput` WS frame and shaping its samples for the timeline track.
// Kept out of the Svelte components so vitest covers it without
// component-test infrastructure.
import { safeJsonParse } from './format'

/** One window's aggregate inside a throughput frame. */
export interface ThroughputWindow {
  throughput: number
  task_rate: number
  tasks: number
}

/** The five fixed windows, keyed by their width in seconds as a string. */
export type ThroughputWindows = Record<string, ThroughputWindow>

/** One received frame, anchored at its wire timestamp. */
export interface ThroughputSample {
  ts: number
  windows: ThroughputWindows
}

/** Contract v1.16 pins this set; every frame carries all five. */
export const THROUGHPUT_WINDOW_KEYS = ['1', '5', '30', '60', '300'] as const

/** Chip labels for the window switcher. */
export const THROUGHPUT_WINDOW_LABELS: Record<string, string> = {
  '1': '1s',
  '5': '5s',
  '30': '30s',
  '60': '60s',
  '300': '5m',
}

function windowOf(value: unknown): ThroughputWindow | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  const throughput = raw.throughput
  const taskRate = raw.task_rate
  const tasks = raw.tasks
  if (typeof throughput !== 'number' || typeof taskRate !== 'number' || typeof tasks !== 'number') {
    return null
  }
  return { throughput, task_rate: taskRate, tasks }
}

/**
 * Parse one `throughput` WS frame. Null when the metadata is malformed or
 * any pinned window is missing — a half-formed frame must not become a
 * misleading dip on the track.
 */
export function throughputFromEvent(event: {
  ts: number
  metadata: string | null | undefined
}): ThroughputSample | null {
  const raw = safeJsonParse<{ windows?: Record<string, unknown> }>(event.metadata ?? undefined, {})
  if (typeof raw.windows !== 'object' || raw.windows === null) return null
  const windows: ThroughputWindows = {}
  for (const key of THROUGHPUT_WINDOW_KEYS) {
    const parsed = windowOf(raw.windows[key])
    if (!parsed) return null
    windows[key] = parsed
  }
  return { ts: event.ts, windows }
}

/**
 * Append a sample and trim everything older than `maxAgeSec` — the track
 * only ever draws the timeline's window, so older samples are dead weight.
 * Returns a new array (Svelte reactivity).
 */
export function pushThroughputSample(
  samples: ThroughputSample[],
  sample: ThroughputSample,
  maxAgeSec: number,
): ThroughputSample[] {
  const cutoff = sample.ts - maxAgeSec
  const kept = samples.filter((s) => s.ts >= cutoff)
  kept.push(sample)
  return kept
}

/** The newest sample at or before `ts`, for the track's hover readout. */
export function sampleAt(samples: ThroughputSample[], ts: number): ThroughputSample | null {
  let best: ThroughputSample | null = null
  for (const sample of samples) {
    if (sample.ts > ts) break
    best = sample
  }
  return best
}

/**
 * Cost values in a human size: the unit is operator-defined, so plain SI
 * suffixes (k/M/G/T) with one decimal — `41.2M`, `950k`, `12`.
 */
export function fmtCost(value: number): string {
  const abs = Math.abs(value)
  if (abs >= 1e12) return `${(value / 1e12).toFixed(1)}T`
  if (abs >= 1e9) return `${(value / 1e9).toFixed(1)}G`
  if (abs >= 1e6) return `${(value / 1e6).toFixed(1)}M`
  if (abs >= 1e3) return `${(value / 1e3).toFixed(1)}k`
  if (abs >= 10 || Number.isInteger(value)) return `${Math.round(value)}`
  return value.toFixed(1)
}

/** Per-task speed for hover details: SI cost per second. */
export function fmtSpeed(speed: number): string {
  return `${fmtCost(speed)}/s`
}
