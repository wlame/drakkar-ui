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
      stacks: [{ stack: '  File "handler.py", line 42\n', location: 'handler.py:42', count: 4 }],
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

const census = {
  unit_label: 'tasks',
  total: 12,
  units: [{ name: 'worker.run', location: 'worker.py:10', count: 12, example: 'worker-0' }],
}

function stubFetch(healthStatus = 200) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/runtime/health')) {
      return new Response(healthStatus === 200 ? JSON.stringify(snapshot) : '{}', {
        status: healthStatus,
      })
    }
    if (url.includes('/events')) {
      return new Response(JSON.stringify(stallEvents), { status: 200 })
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

    const row = target.querySelector('tr.stall-row') as HTMLTableRowElement
    expect(row).not.toBeNull()
    row.click()
    flushSync()
    expect(target.textContent).toContain('sampled 4×')

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
})
