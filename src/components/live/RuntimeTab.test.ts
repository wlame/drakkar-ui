// Mounts the real Runtime tab against a stubbed fetch: snapshot + stall
// events on load, census on demand, and the 404 "no monitor" contract case.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import RuntimeTab from './RuntimeTab.svelte'

const snapshot = {
  enabled: true,
  state: 'degraded',
  unit_label: 'tasks',
  current_lag_ms: 142.5,
  heartbeat_age_ms: 90.1,
  window: [
    { t: 100, max_lag_ms: 5, avg_lag_ms: 2 },
    { t: 101, max_lag_ms: 142.5, avg_lag_ms: 60 },
  ],
  recent_stalls: [],
}

const stallEvents = [
  {
    id: 7,
    ts: 1700000000,
    dt: '',
    event: 'runtime_stall',
    partition: null,
    offset: null,
    task_id: null,
    args: null,
    stdout_size: 0,
    stdout: null,
    stderr: null,
    exit_code: null,
    duration: 2.1,
    output_topic: null,
    metadata: JSON.stringify({
      duration_ms: 2100,
      // Two stacks sharing one location: the sampler reports the blocking
      // SITE, and distinct call paths into it produce distinct stack texts
      // with the same location. Keying the expanded list on location crashed
      // the click with each_key_duplicate — pinned by the expand test below.
      stacks: [
        { stack: '  File "handler.py", line 42\n', location: 'handler.py:42', count: 4 },
        {
          stack: '  File "sinks.py", line 9\n  File "handler.py", line 42\n',
          location: 'handler.py:42',
          count: 2,
        },
      ],
      dropped_stacks: 0,
      unit_count: 33,
    }),
    pid: null,
    labels: null,
    origin: 'kafka',
    client_name: null,
    request_id: null,
  },
]

const episodeEvents = [
  {
    id: 9,
    ts: 1700000100,
    dt: '',
    event: 'runtime_lag_episode',
    partition: null,
    offset: null,
    task_id: null,
    args: null,
    stdout_size: 0,
    stdout: null,
    stderr: null,
    exit_code: null,
    duration: 45.2,
    output_topic: null,
    metadata: JSON.stringify({
      duration_ms: 45200,
      peak_lag_ms: 1900,
      lag_sum_ms: 8000,
      cpu_ms: 210,
      cpu_ratio: 0.005,
      verdict: 'starved',
      stall_count: 3,
      sample_count: 40,
      stacks: [{ stack: '  File "selectors.py", line 5\n', location: 'selectors.py:5', count: 40 }],
      dropped_stacks: 0,
      unit_count: 7000,
      cpu_throttled_ms: 4200,
    }),
    pid: null,
    labels: null,
    origin: 'kafka',
    client_name: null,
    request_id: null,
  },
]

const resourceSampleEvents = [
  {
    id: 11,
    ts: 1700000200,
    dt: '',
    event: 'resource_sample',
    partition: null,
    offset: null,
    task_id: null,
    args: null,
    stdout_size: 0,
    stdout: null,
    stderr: null,
    exit_code: null,
    duration: null,
    output_topic: null,
    metadata: JSON.stringify({
      rss_bytes: 1024,
      interval_s: 10,
      load1: 12.4,
      load5: 8.1,
      psi_cpu_some_avg10: 34.5,
      psi_io_some_avg10: 2.0,
      psi_io_full_avg10: 0.5,
      cpu_throttled_periods: 12,
      cpu_throttled_ms: 4300,
      nfs_mounts: [{ mount: '/mnt/data', ops: 120, rtt_ms: 512.5, retrans: 4 }],
    }),
    pid: null,
    labels: null,
    origin: 'kafka',
    client_name: null,
    request_id: null,
  },
]

const census = {
  unit_label: 'tasks',
  total: 12,
  units: [{ name: 'worker.run', location: 'worker.py:10', count: 12, example: 'worker-0' }],
}

function stubFetch(healthStatus = 200, snapshotBody: object = snapshot) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/runtime/health')) {
      return new Response(healthStatus === 200 ? JSON.stringify(snapshotBody) : '{}', {
        status: healthStatus,
      })
    }
    if (url.includes('/events')) {
      if (url.includes('resource_sample')) {
        return new Response(JSON.stringify(resourceSampleEvents), { status: 200 })
      }
      // The stall query asks for both types in one request.
      return new Response(JSON.stringify([...stallEvents, ...episodeEvents]), { status: 200 })
    }
    if (url.includes('/debug/runtime/units')) {
      return new Response(JSON.stringify(census), { status: 200 })
    }
    return new Response('{}', { status: 200 })
  })
}

async function settled() {
  // Let the $effect's async reload chain (two sequential fetches, each
  // with a .json() await) resolve: each macrotask turn drains the pending
  // microtask queue, and flushSync applies the resulting state.
  for (let i = 0; i < 4; i++) {
    flushSync()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  flushSync()
}

describe('RuntimeTab', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders state badge, lag figures, sparkline, and stall rows', async () => {
    vi.stubGlobal('fetch', stubFetch())
    const target = document.createElement('div')
    document.body.appendChild(target)
    const component = mount(RuntimeTab, { target })
    await settled()

    expect(target.textContent).toContain('degraded')
    expect(target.textContent).toContain('143 ms')
    expect(target.querySelector('svg polyline')).not.toBeNull()
    // Collapsed stall row: duration + stack count; the stacks themselves
    // only render after expanding (covered by the next test).
    expect(target.textContent).toContain('2100 ms')
    expect(target.querySelector('tr.stall-row')).not.toBeNull()

    await unmount(component)
    target.remove()
  })

  it('expands a stall row into its captured stacks', async () => {
    vi.stubGlobal('fetch', stubFetch())
    const target = document.createElement('div')
    document.body.appendChild(target)
    const component = mount(RuntimeTab, { target })
    await settled()

    // The merged list sorts newest-first, so the hard stall is not
    // necessarily the first row — pick it by its duration.
    const row = [...target.querySelectorAll('tr.stall-row')].find((r) =>
      r.textContent?.includes('2100 ms'),
    ) as HTMLTableRowElement
    expect(row).not.toBeNull()
    row.click()
    flushSync()
    // Both stacks render — including the second one sharing the first's
    // location, which used to crash the whole expand.
    expect(target.textContent).toContain('sampled 4×')
    expect(target.textContent).toContain('sampled 2×')

    await unmount(component)
    target.remove()
  })

  it('fetches and renders the census on demand', async () => {
    vi.stubGlobal('fetch', stubFetch())
    const target = document.createElement('div')
    document.body.appendChild(target)
    const component = mount(RuntimeTab, { target })
    await settled()

    const button = [...target.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Sample now'),
    ) as HTMLButtonElement
    button.click()
    await settled()

    expect(target.textContent).toContain('12 tasks in 1 groups')
    expect(target.textContent).toContain('worker.run')

    await unmount(component)
    target.remove()
  })

  it('renders the no-monitor explanation on the contract 404', async () => {
    vi.stubGlobal('fetch', stubFetch(404))
    const target = document.createElement('div')
    document.body.appendChild(target)
    const component = mount(RuntimeTab, { target })
    await settled()

    expect(target.textContent).toContain('No runtime monitor on this worker')

    await unmount(component)
    target.remove()
  })

  it('renders episode rows with their verdict chip', async () => {
    vi.stubGlobal('fetch', stubFetch())
    const target = document.createElement('div')
    document.body.appendChild(target)
    const component = mount(RuntimeTab, { target })
    await settled()

    expect(target.textContent).toContain('episode (3 stalls)')
    expect(target.textContent).toContain('starved')
    expect(target.textContent).toContain('45.2 s')

    await unmount(component)
    target.remove()
  })

  it('shows the in-progress episode card from the snapshot during an incident', async () => {
    const incidentSnapshot = {
      ...snapshot,
      state: 'stalled',
      current_episode: {
        started_t: 1700000300,
        wall_ms: 32500,
        peak_lag_ms: 13200,
        cpu_ms: 120,
        sample_count: 18,
        verdict: 'starved',
      },
      recent_episodes: [],
    }
    vi.stubGlobal('fetch', stubFetch(200, incidentSnapshot))
    const target = document.createElement('div')
    document.body.appendChild(target)
    const component = mount(RuntimeTab, { target })
    await settled()

    expect(target.textContent).toContain('Episode in progress')
    expect(target.textContent).toContain('32.5 s so far')
    expect(target.textContent).toContain('did not get it')

    await unmount(component)
    target.remove()
  })

  it('falls back to snapshot summaries when the events query returns nothing', async () => {
    // The exact incident shape from production: stalled badge, degraded
    // recorder, zero persisted rows — the snapshot's in-memory summaries
    // must still render instead of "No stalls recorded".
    const memoryOnlySnapshot = {
      ...snapshot,
      recent_stalls: [
        { t: 1700000400, duration_ms: 13200, stack_count: 2, top_location: 'x.py:1' },
      ],
      recent_episodes: [
        {
          t: 1700000500,
          duration_ms: 60000,
          verdict: 'starved',
          peak_lag_ms: 19400,
          top_location: null,
        },
      ],
    }
    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/runtime/health')) {
        return new Response(JSON.stringify(memoryOnlySnapshot), { status: 200 })
      }
      if (url.includes('/events')) {
        return new Response('[]', { status: 200 })
      }
      return new Response('{}', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchStub)
    const target = document.createElement('div')
    document.body.appendChild(target)
    const component = mount(RuntimeTab, { target })
    await settled()

    expect(target.textContent).not.toContain('No stalls or lag episodes recorded')
    expect(target.textContent).toContain('13.2 s')
    expect(target.textContent).toContain('starved')
    expect(target.textContent).toContain('from monitor memory')

    await unmount(component)
    target.remove()
  })

  it('renders the host section from the pressure prop', async () => {
    vi.stubGlobal('fetch', stubFetch())
    const target = document.createElement('div')
    document.body.appendChild(target)
    const component = mount(RuntimeTab, {
      target,
      props: {
        hostPressure: {
          ts: 1700000600,
          load1: 24.5,
          load5: 20.1,
          psiCpuSome: 41.2,
          psiIoSome: 3.5,
          psiIoFull: 1.2,
          psiMemSome: null,
          psiMemFull: null,
          throttledPeriods: 40,
          throttledMs: 4300,
          intervalS: 10,
          nfsMounts: [{ mount: '/mnt/data', ops: 120, rtt_ms: 512.5, retrans: 4 }],
          goroutines: null,
          schedLatencyP99Ms: null,
          gcPauseP99Ms: null,
        },
      },
    })
    await settled()

    expect(target.textContent).toContain('Host')
    expect(target.textContent).toContain('24.5 / 20.1')
    expect(target.textContent).toContain('41.2%')
    expect(target.textContent).toContain('43%') // 4300 ms of a 10 s interval
    expect(target.textContent).toContain('/mnt/data')
    expect(target.textContent).toContain('513 ms') // fmtLagMs(512.5)

    await unmount(component)
    target.remove()
  })

  it('seeds the host section from the latest persisted sample without the prop', async () => {
    vi.stubGlobal('fetch', stubFetch())
    const target = document.createElement('div')
    document.body.appendChild(target)
    const component = mount(RuntimeTab, { target })
    await settled()

    expect(target.textContent).toContain('12.4 / 8.1')
    expect(target.textContent).toContain('34.5%')

    await unmount(component)
    target.remove()
  })

  it('says nothing degraded only when every source is empty', async () => {
    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/runtime/health')) {
        return new Response(JSON.stringify(snapshot), { status: 200 })
      }
      return new Response('[]', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchStub)
    const target = document.createElement('div')
    document.body.appendChild(target)
    const component = mount(RuntimeTab, { target })
    await settled()

    expect(target.textContent).toContain('No stalls or lag episodes recorded')

    await unmount(component)
    target.remove()
  })
})
