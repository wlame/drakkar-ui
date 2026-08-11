// Distribution statistics over the tasks the browser currently holds.
// Feeds the stats strip under the Live timeline (per worker in cluster view)
// and the Dashboard's task-duration card. Everything here is computed from
// in-memory TaskViews — no backend endpoint, so the numbers always describe
// exactly the window the operator is looking at.

import type { TaskView } from './live'

export interface DistStats {
  count: number
  avg: number
  p50: number
  p90: number
  p99: number
}

/**
 * Average and percentiles (linear interpolation between closest ranks) of a
 * sample. Returns null for an empty sample so callers render "no data"
 * instead of a fake zero row.
 */
export function distStats(values: number[]): DistStats | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  let sum = 0
  for (const v of sorted) sum += v
  return {
    count: sorted.length,
    avg: sum / sorted.length,
    p50: percentileSorted(sorted, 50),
    p90: percentileSorted(sorted, 90),
    p99: percentileSorted(sorted, 99),
  }
}

// Linear interpolation on an ALREADY SORTED sample (the "exclusive of the
// caller re-sorting per percentile" split keeps distStats one sort total).
function percentileSorted(sorted: number[], p: number): number {
  const rank = (p / 100) * (sorted.length - 1)
  const lo = Math.floor(rank)
  const hi = Math.ceil(rank)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo)
}

/** Durations (seconds) of the finished tasks in the sample. */
export function taskDurations(tasks: TaskView[]): number[] {
  const out: number[] = []
  for (const t of tasks) {
    if (t.duration != null && (t.status === 'completed' || t.status === 'failed')) {
      out.push(t.duration)
    }
  }
  return out
}

/**
 * Numeric values of one label across the sample. Strict parsing: the whole
 * string must be a number ("12.5" yes, "0:41" and "1.2K" no), so a
 * non-numeric label never pollutes the distribution with false zeros.
 */
export function numericLabelValues(tasks: TaskView[], key: string): number[] {
  const out: number[] = []
  for (const t of tasks) {
    const raw = t.labels?.[key]
    if (raw === undefined) continue
    const value = strictNumber(raw)
    if (value !== null) out.push(value)
  }
  return out
}

/**
 * Label keys that carry a numeric value on at least one task — the options
 * for the stats strip's label picker, sorted for a stable dropdown.
 */
export function numericLabelKeys(tasks: TaskView[]): string[] {
  const keys = new Set<string>()
  for (const t of tasks) {
    if (!t.labels) continue
    for (const [k, v] of Object.entries(t.labels)) {
      if (!keys.has(k) && strictNumber(v) !== null) keys.add(k)
    }
  }
  return [...keys].sort()
}

// Number(x) accepts ''/whitespace as 0 — guard against that; parseFloat
// accepts trailing junk ("1.2K" → 1.2) — Number() guards against that.
function strictNumber(raw: string): number | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const value = Number(trimmed)
  return Number.isFinite(value) ? value : null
}
