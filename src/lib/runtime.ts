// Helpers behind the Live page's Runtime tab. Kept out of the Svelte
// component so vitest covers them without component-test infrastructure.
import type {
  RuntimeHealthSnapshot,
  RuntimeLagBucket,
  RuntimeLagEpisodePayload,
  RuntimeStallPayload,
  RuntimeVerdict,
} from './types'
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

// --- Lag episodes and verdicts (contract v1.15) ------------------------------

/**
 * Plain-language rendering of each episode verdict — the chip label and the
 * one-liner under it. Written for the operator mid-incident: what happened,
 * and where to look next.
 */
export const VERDICT_LABELS: Record<RuntimeVerdict, { label: string; hint: string }> = {
  blocked: {
    label: 'blocked',
    hint: 'The runtime sat in one call site with little CPU — the top stack names the blocking call.',
  },
  cpu_bound: {
    label: 'cpu bound',
    hint: 'The runtime itself consumed the wall time — the top stack shows the hot site; move that work off the loop.',
  },
  starved: {
    label: 'starved',
    hint: 'The process wanted CPU and did not get it — host-level contention (throttling, oversubscription), not your code.',
  },
  inconclusive: {
    label: 'inconclusive',
    hint: 'No single pattern dominated — check the raw CPU, stack, and host-pressure numbers.',
  },
}

const VERDICTS = new Set<RuntimeVerdict>(['blocked', 'cpu_bound', 'starved', 'inconclusive'])

function verdictOf(value: unknown): RuntimeVerdict {
  return VERDICTS.has(value as RuntimeVerdict) ? (value as RuntimeVerdict) : 'inconclusive'
}

/**
 * Parse one runtime_lag_episode event's metadata JSON. Tolerant like
 * stallFromMetadata: one bad row degrades, never breaks the list.
 */
export function episodeFromMetadata(metadata: string | null | undefined): RuntimeLagEpisodePayload {
  const raw = safeJsonParse<Partial<RuntimeLagEpisodePayload>>(metadata ?? undefined, {})
  return {
    duration_ms: typeof raw.duration_ms === 'number' ? raw.duration_ms : 0,
    peak_lag_ms: typeof raw.peak_lag_ms === 'number' ? raw.peak_lag_ms : 0,
    lag_sum_ms: typeof raw.lag_sum_ms === 'number' ? raw.lag_sum_ms : 0,
    verdict: verdictOf(raw.verdict),
    stall_count: typeof raw.stall_count === 'number' ? raw.stall_count : 0,
    sample_count: typeof raw.sample_count === 'number' ? raw.sample_count : 0,
    stacks: Array.isArray(raw.stacks) ? raw.stacks : [],
    dropped_stacks: typeof raw.dropped_stacks === 'number' ? raw.dropped_stacks : 0,
    unit_count: typeof raw.unit_count === 'number' ? raw.unit_count : -1,
    ...(typeof raw.cpu_ms === 'number' ? { cpu_ms: raw.cpu_ms } : {}),
    ...(typeof raw.cpu_ratio === 'number' ? { cpu_ratio: raw.cpu_ratio } : {}),
    ...(typeof raw.cpu_throttled_ms === 'number' ? { cpu_throttled_ms: raw.cpu_throttled_ms } : {}),
    ...(typeof raw.psi_cpu_some_avg10 === 'number'
      ? { psi_cpu_some_avg10: raw.psi_cpu_some_avg10 }
      : {}),
    ...(typeof raw.load1 === 'number' ? { load1: raw.load1 } : {}),
  }
}

/**
 * One row of the merged Stalls list: a hard stall or a closed episode, from
 * either the persisted events or the snapshot's in-memory summaries.
 */
export interface StallListItem {
  id: string
  kind: 'stall' | 'episode'
  t: number
  durationMs: number
  /** Episodes only; null for stalls. */
  verdict: RuntimeVerdict | null
  stackCount: number
  /** Full stacks — only persisted rows carry them; snapshot entries render without expand. */
  stacks: { stack: string; location: string; count: number }[]
  droppedStacks: number
  unitCount: number | null
  peakLagMs: number | null
  stallCount: number | null
  cpuRatio: number | null
  /** True when the entry exists only in monitor memory (the persisted row
   * never landed — exactly what happens while the recorder is degraded). */
  fromSnapshotOnly: boolean
}

// Snapshot timestamps and event timestamps describe the same moment but pass
// through different float paths; treat anything within this window as the
// same stall/episode when deduplicating.
const DEDUPE_WINDOW_S = 2

/**
 * Merge the three stall-evidence sources into one newest-first list:
 * persisted runtime_stall + runtime_lag_episode rows (rich: full stacks)
 * and the snapshot's recent_stalls / recent_episodes (survive a degraded
 * recorder — the exact incident mode that used to render "No stalls
 * recorded" under a stalled badge).
 */
export function mergeStallSources(
  stallEvents: { id: number; ts: number; metadata: string | null }[],
  episodeEvents: { id: number; ts: number; metadata: string | null }[],
  snapshot: RuntimeHealthSnapshot | null,
): StallListItem[] {
  const items: StallListItem[] = []

  for (const row of stallEvents) {
    const stall = stallFromMetadata(row.metadata)
    items.push({
      id: `stall-event-${row.id}`,
      kind: 'stall',
      t: row.ts,
      durationMs: stall.duration_ms,
      verdict: null,
      stackCount: stall.stacks.length,
      stacks: stall.stacks,
      droppedStacks: stall.dropped_stacks,
      unitCount: stall.unit_count >= 0 ? stall.unit_count : null,
      peakLagMs: null,
      stallCount: null,
      cpuRatio: null,
      fromSnapshotOnly: false,
    })
  }
  for (const row of episodeEvents) {
    const episode = episodeFromMetadata(row.metadata)
    items.push({
      id: `episode-event-${row.id}`,
      kind: 'episode',
      t: row.ts,
      durationMs: episode.duration_ms,
      verdict: episode.verdict,
      stackCount: episode.stacks.length,
      stacks: episode.stacks,
      droppedStacks: episode.dropped_stacks,
      unitCount: episode.unit_count >= 0 ? episode.unit_count : null,
      peakLagMs: episode.peak_lag_ms,
      stallCount: episode.stall_count,
      cpuRatio: episode.cpu_ratio ?? null,
      fromSnapshotOnly: false,
    })
  }

  const covered = (kind: StallListItem['kind'], t: number) =>
    items.some((item) => item.kind === kind && Math.abs(item.t - t) <= DEDUPE_WINDOW_S)

  for (const stall of snapshot?.recent_stalls ?? []) {
    if (covered('stall', stall.t)) continue
    items.push({
      id: `stall-snap-${stall.t}`,
      kind: 'stall',
      t: stall.t,
      durationMs: stall.duration_ms,
      verdict: null,
      stackCount: stall.stack_count,
      stacks: [],
      droppedStacks: 0,
      unitCount: null,
      peakLagMs: null,
      stallCount: null,
      cpuRatio: null,
      fromSnapshotOnly: true,
    })
  }
  for (const episode of snapshot?.recent_episodes ?? []) {
    if (covered('episode', episode.t)) continue
    items.push({
      id: `episode-snap-${episode.t}`,
      kind: 'episode',
      t: episode.t,
      durationMs: episode.duration_ms,
      verdict: episode.verdict,
      stackCount: 0,
      stacks: [],
      droppedStacks: 0,
      unitCount: null,
      peakLagMs: episode.peak_lag_ms,
      stallCount: null,
      cpuRatio: null,
      fromSnapshotOnly: true,
    })
  }

  return items.sort((a, b) => b.t - a.t)
}
