// Host-pressure readings from resource_sample events (contract v1.15):
// which resource is the host fighting for. Kept out of the Svelte
// component so vitest covers the parsing without component-test
// infrastructure.
import type { NFSMountHealth } from './types'
import { safeJsonParse } from './format'

/**
 * The pressure view one resource_sample yields. Every field is null when
 * its key was absent — the backend omits keys whose platform source is
 * unavailable, and the UI hides the matching tile.
 */
export interface HostPressure {
  ts: number
  load1: number | null
  load5: number | null
  psiCpuSome: number | null
  psiIoSome: number | null
  psiIoFull: number | null
  psiMemSome: number | null
  psiMemFull: number | null
  throttledPeriods: number | null
  throttledMs: number | null
  intervalS: number | null
  nfsMounts: NFSMountHealth[]
  /** Go-only optional keys; null on Python workers. */
  goroutines: number | null
  schedLatencyP99Ms: number | null
  gcPauseP99Ms: number | null
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function nfsMounts(value: unknown): NFSMountHealth[] {
  if (!Array.isArray(value)) return []
  const mounts: NFSMountHealth[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const row = entry as Record<string, unknown>
    if (typeof row.mount !== 'string') continue
    mounts.push({
      mount: row.mount,
      ops: num(row.ops) ?? 0,
      rtt_ms: num(row.rtt_ms) ?? 0,
      retrans: num(row.retrans) ?? 0,
    })
  }
  return mounts
}

/**
 * Parse one resource_sample event into a HostPressure view, or null when
 * the sample carries no pressure data at all (a pre-v1.15 backend, or a
 * platform where every source is unavailable) — the Host section then
 * stays hidden rather than rendering a wall of dashes.
 */
export function hostPressureFromEvent(event: {
  ts: number
  metadata: string | null | undefined
}): HostPressure | null {
  const raw = safeJsonParse<Record<string, unknown>>(event.metadata ?? undefined, {})
  const pressure: HostPressure = {
    ts: event.ts,
    load1: num(raw.load1),
    load5: num(raw.load5),
    psiCpuSome: num(raw.psi_cpu_some_avg10),
    psiIoSome: num(raw.psi_io_some_avg10),
    psiIoFull: num(raw.psi_io_full_avg10),
    psiMemSome: num(raw.psi_mem_some_avg10),
    psiMemFull: num(raw.psi_mem_full_avg10),
    throttledPeriods: num(raw.cpu_throttled_periods),
    throttledMs: num(raw.cpu_throttled_ms),
    intervalS: num(raw.interval_s),
    nfsMounts: nfsMounts(raw.nfs_mounts),
    goroutines: num(raw.goroutines),
    schedLatencyP99Ms: num(raw.sched_latency_p99_ms),
    gcPauseP99Ms: num(raw.gc_pause_p99_ms),
  }
  return hasPressureData(pressure) ? pressure : null
}

/** True when at least one pressure signal (beyond ts/interval) is present. */
export function hasPressureData(pressure: HostPressure): boolean {
  return (
    pressure.load1 !== null ||
    pressure.psiCpuSome !== null ||
    pressure.psiIoSome !== null ||
    pressure.psiMemSome !== null ||
    pressure.throttledMs !== null ||
    pressure.nfsMounts.length > 0 ||
    pressure.schedLatencyP99Ms !== null
  )
}

/**
 * CPU throttling as a percent of the sample interval — "we were descheduled
 * by the quota for 43% of the last 10 s". Null when either side is missing
 * or the interval is zero.
 */
export function throttlePct(throttledMs: number | null, intervalS: number | null): number | null {
  if (throttledMs === null || intervalS === null || intervalS <= 0) return null
  return Math.min(100, Math.round((throttledMs / (intervalS * 1000)) * 100))
}
