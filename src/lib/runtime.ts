// Helpers behind the Live page's Runtime tab. Kept out of the Svelte
// component so vitest covers them without component-test infrastructure.
import type { RuntimeLagBucket, RuntimeStallPayload } from './types'
import { safeJsonParse } from './format'

export type RuntimeState = 'healthy' | 'degraded' | 'stalled'

// Badge/sparkline colors, matching the pool-utilization thresholds the
// Live page already uses (emerald / amber / red).
export const STATE_COLORS: Record<RuntimeState, string> = {
  healthy: '#34d399',
  degraded: '#fbbf24',
  stalled: '#f87171',
}

/**
 * Scale lag buckets into SVG polyline points for the sparkline.
 *
 * X spreads the buckets over `width` by their position in the array (the
 * backend emits one bucket per active second; quiet seconds are simply
 * absent, and stretching by index keeps the line continuous instead of
 * gappy). Y is max-lag on a scale from 0 to the window's peak, floored at
 * `minCeilingMs` so a perfectly healthy window (sub-ms lags) renders as a
 * flat line near the bottom instead of amplified noise.
 */
export function sparklinePoints(
  window: RuntimeLagBucket[],
  width: number,
  height: number,
  minCeilingMs = 100,
): string {
  if (window.length === 0) return ''
  const peak = Math.max(minCeilingMs, ...window.map((b) => b.max_lag_ms))
  const stepX = window.length > 1 ? width / (window.length - 1) : 0
  return window
    .map((bucket, i) => {
      const x = window.length > 1 ? i * stepX : width / 2
      const y = height - (bucket.max_lag_ms / peak) * height
      return `${round1(x)},${round1(y)}`
    })
    .join(' ')
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

/** Peak max-lag of the window, for the sparkline's axis label. */
export function windowPeakMs(window: RuntimeLagBucket[]): number {
  return window.length ? Math.max(...window.map((b) => b.max_lag_ms)) : 0
}

/** A human lag figure: sub-ms shows fine detail, seconds above 10s. */
export function fmtLagMs(ms: number): string {
  if (ms >= 10_000) return `${(ms / 1000).toFixed(1)} s`
  if (ms >= 100) return `${Math.round(ms)} ms`
  return `${ms.toFixed(1)} ms`
}

/**
 * Parse one runtime_stall event's metadata JSON into its payload.
 * Tolerates absent/malformed metadata (degrades to an empty-stack stall)
 * so one bad row cannot break the stall list.
 */
export function stallFromMetadata(metadata: string | null | undefined): RuntimeStallPayload {
  const raw = safeJsonParse<Partial<RuntimeStallPayload>>(metadata ?? undefined, {})
  return {
    duration_ms: typeof raw.duration_ms === 'number' ? raw.duration_ms : 0,
    stacks: Array.isArray(raw.stacks) ? raw.stacks : [],
    dropped_stacks: typeof raw.dropped_stacks === 'number' ? raw.dropped_stacks : 0,
    unit_count: typeof raw.unit_count === 'number' ? raw.unit_count : -1,
  }
}

// One row of the "Top blocking sites" table: every stall's captured stacks,
// re-grouped by the code location that blocked the loop. This is the
// "analyze later" view over recorded stalls — a site that keeps showing up
// across stalls is the fix target, even when each individual stall looks
// different.
export interface StallSiteAggregate {
  location: string
  // Stall events in which this site was captured at least once.
  stalls: number
  // Total sampler hits at this site, across all stalls (the sampler counts
  // how often it saw each site while the loop was blocked — a proxy for how
  // much of the blocked time this site owns).
  samples: number
  // Sum of the full durations of the stalls this site appeared in. An upper
  // bound on the site's cost: co-captured sites share one stall's duration.
  totalMs: number
  lastTs: number
  // One representative stack for the site (from its most recent stall).
  exampleStack: string
}

/** Group recorded runtime_stall events by blocking site, busiest first. */
export function aggregateStallSites(
  events: { ts: number; metadata: string | null }[],
): StallSiteAggregate[] {
  const byLocation = new Map<string, StallSiteAggregate>()
  for (const event of events) {
    const stall = stallFromMetadata(event.metadata)
    // One stall can capture a location more than once (distinct call paths
    // into the same site); count the stall and its duration once per site.
    const seenThisStall = new Set<string>()
    for (const stack of stall.stacks) {
      let aggregate = byLocation.get(stack.location)
      if (!aggregate) {
        aggregate = {
          location: stack.location,
          stalls: 0,
          samples: 0,
          totalMs: 0,
          lastTs: 0,
          exampleStack: '',
        }
        byLocation.set(stack.location, aggregate)
      }
      if (!seenThisStall.has(stack.location)) {
        seenThisStall.add(stack.location)
        aggregate.stalls += 1
        aggregate.totalMs += stall.duration_ms
      }
      aggregate.samples += stack.count
      if (event.ts >= aggregate.lastTs) {
        aggregate.lastTs = event.ts
        aggregate.exampleStack = stack.stack
      }
    }
  }
  return [...byLocation.values()].sort((a, b) => b.samples - a.samples)
}
