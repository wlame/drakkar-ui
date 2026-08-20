import { describe, expect, it } from 'vitest'
import { hostPressureFromEvent, hasPressureData, throttlePct } from './hostpressure'

function sampleEvent(metadata: object | string | null) {
  return {
    ts: 1700000000,
    metadata:
      typeof metadata === 'string' || metadata === null ? metadata : JSON.stringify(metadata),
  }
}

describe('hostPressureFromEvent', () => {
  it('parses every pressure key', () => {
    const pressure = hostPressureFromEvent(
      sampleEvent({
        load1: 12.4,
        load5: 8.1,
        psi_cpu_some_avg10: 34.5,
        psi_io_some_avg10: 2.0,
        psi_io_full_avg10: 0.5,
        psi_mem_some_avg10: 0.1,
        psi_mem_full_avg10: 0.0,
        cpu_throttled_periods: 12,
        cpu_throttled_ms: 4300,
        interval_s: 10,
        nfs_mounts: [{ mount: '/mnt/data', ops: 120, rtt_ms: 512.5, retrans: 4 }],
        goroutines: 250,
        sched_latency_p99_ms: 88.2,
        gc_pause_p99_ms: 1.5,
      }),
    )
    expect(pressure).not.toBeNull()
    expect(pressure?.load1).toBe(12.4)
    expect(pressure?.psiCpuSome).toBe(34.5)
    expect(pressure?.psiMemFull).toBe(0.0)
    expect(pressure?.throttledMs).toBe(4300)
    expect(pressure?.nfsMounts).toEqual([
      { mount: '/mnt/data', ops: 120, rtt_ms: 512.5, retrans: 4 },
    ])
    expect(pressure?.goroutines).toBe(250)
    expect(pressure?.schedLatencyP99Ms).toBe(88.2)
  })

  it('nulls absent keys instead of zeroing them', () => {
    const pressure = hostPressureFromEvent(sampleEvent({ load1: 1.0 }))
    expect(pressure?.load1).toBe(1.0)
    expect(pressure?.psiCpuSome).toBeNull()
    expect(pressure?.throttledMs).toBeNull()
    expect(pressure?.nfsMounts).toEqual([])
  })

  it('returns null when the sample carries no pressure data at all', () => {
    // A pre-v1.15 resource_sample: only process facts, no host keys.
    expect(hostPressureFromEvent(sampleEvent({ rss_bytes: 1024, threads: 20 }))).toBeNull()
  })

  it('tolerates malformed metadata and entries', () => {
    expect(hostPressureFromEvent(sampleEvent('not json'))).toBeNull()
    expect(hostPressureFromEvent(sampleEvent(null))).toBeNull()
    const pressure = hostPressureFromEvent(
      sampleEvent({ load1: 2.0, nfs_mounts: [{ ops: 1 }, 'garbage', { mount: '/ok' }] }),
    )
    // Entries without a mount name (or non-objects) are dropped; a mount
    // with missing numbers degrades to zeros.
    expect(pressure?.nfsMounts).toEqual([{ mount: '/ok', ops: 0, rtt_ms: 0, retrans: 0 }])
  })
})

describe('hasPressureData', () => {
  it('counts any single signal as data', () => {
    const base = hostPressureFromEvent(sampleEvent({ sched_latency_p99_ms: 5 }))
    expect(base).not.toBeNull()
    expect(hasPressureData(base!)).toBe(true)
  })
})

describe('throttlePct', () => {
  it('reports throttled time as a percent of the interval', () => {
    expect(throttlePct(4300, 10)).toBe(43)
  })
  it('caps at 100', () => {
    expect(throttlePct(99999, 10)).toBe(100)
  })
  it('is null without both sides', () => {
    expect(throttlePct(null, 10)).toBeNull()
    expect(throttlePct(4300, null)).toBeNull()
    expect(throttlePct(4300, 0)).toBeNull()
  })
})
