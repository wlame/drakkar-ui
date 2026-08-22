// Mounts the real Live page against a stubbed backend. Two behaviors are
// pinned here: a degraded /recent-tasks response must leave the last good
// state on screen behind a visible notice (it used to freeze the page in
// silence), and the cluster-view toggle must stack a timeline per worker
// without persisting anything.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import Live from './Live.svelte'
import { identity } from '../lib/config'
import { hash } from '../lib/router'
import type { Identity, RecentTask, TimelineConfig, WorkerPeer } from '../lib/types'

// Stubbed rather than opening a real socket: happy-dom's WebSocket would try
// to connect, and these tests drive the page entirely through its HTTP resync.
// The captured options let a test push WS frames / status changes into the
// page by hand. The rest of the module (WS_STATUS_LABELS) stays real.
let socketOpts: import('../lib/ws').LiveSocketOptions | null = null
vi.mock('../lib/ws', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/ws')>()
  return {
    ...actual,
    createLiveSocket: vi.fn((opts: import('../lib/ws').LiveSocketOptions) => {
      socketOpts = opts
      return {
        close: vi.fn(),
        setFrozen: vi.fn(),
        setSuspended: vi.fn(),
      }
    }),
  }
})

const NOW = Date.now() / 1000
const RESYNC_INTERVAL_MS = 5000

function recentTask(id: string, endOffset: number): RecentTask {
  return {
    task_id: id,
    partition: 0,
    start_ts: NOW - endOffset - 1,
    end_ts: NOW - endOffset,
    duration: 1,
    status: 'completed',
    args: null,
    pid: null,
    slot: 0,
    labels: null,
    env: null,
    origin: 'kafka',
    client_name: null,
    request_id: null,
  }
}

function timelineConfig(history_factor: number): TimelineConfig {
  return { history_factor, max_age_minutes: 30, color_rules: [], labels: {} }
}

function identityWith(timeline: TimelineConfig): Identity {
  return { worker_id: 'w1', cluster: null, config_summary: '', timeline }
}

function okJson(data: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => data,
    text: async () => JSON.stringify(data),
  } as unknown as Response
}

// What GET /api/v1/recent-tasks answers with next. Reassigned mid-test to make
// the backend degrade and recover.
let recentPayload: unknown
// What GET /api/v1/workers answers with (cluster-view tests set it).
let workersPayload: WorkerPeer[] = []
// What GET /api/v1/live/overview answers with. Reassigned by the offload
// readout tests — key-presence of `offload` is the contract's feature flag.
let overviewPayload: Record<string, unknown>

function defaultOverview(): Record<string, unknown> {
  return {
    pool_max: 4,
    pool_active: 0,
    pool_waiting: 0,
    partition_count: 1,
    max_ui_rows: 5000,
    hook_flags: { task_complete: false, message_complete: false, window_complete: false },
  }
}

const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input)
  if (url.includes('/recent-tasks')) return okJson(recentPayload)
  if (url.includes('/workers')) return okJson(workersPayload)
  if (url.includes('/live/overview')) return okJson(overviewPayload)
  return okJson([])
})

beforeEach(() => {
  // Fake timers from before mount: the 5s resync interval is created during
  // mount, and an interval created under real timers stays invisible to a
  // clock installed afterwards.
  vi.useFakeTimers()
  recentPayload = { tasks: [recentTask('t-1', 2), recentTask('t-2', 1)], lane_count: 4 }
  workersPayload = []
  overviewPayload = defaultOverview()
  socketOpts = null
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
  identity.set(null)
  // The router's fragment store is module-global, so a tab selected by one
  // test would otherwise decide the active tab of the next one.
  hash.set('')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  identity.set(null)
  hash.set('')
})

// Drains the page's awaited fetches (bootstrap, resync, feed reloads) against
// the fake clock, then applies the resulting state to the DOM.
async function settled() {
  for (let i = 0; i < 6; i++) {
    flushSync()
    await vi.advanceTimersByTimeAsync(0)
  }
  flushSync()
}

async function nextResync() {
  await vi.advanceTimersByTimeAsync(RESYNC_INTERVAL_MS)
  await settled()
}

function mountLive() {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(Live, { target, props: {} })
  return {
    target,
    teardown: () => {
      unmount(app)
      target.remove()
    },
  }
}

// The finished table is gone; the timeline's bars are the page's task view.
// Sorted, because bar order is map-insertion order, not display order.
function taskIds(target: HTMLElement): string[] {
  return [...target.querySelectorAll('a.bar')].map((a) => a.getAttribute('aria-label') ?? '').sort()
}

// Switches tabs the way an operator does — the button writes the fragment the
// page routes on.
function selectTab(target: HTMLElement, label: string) {
  const tab = [...target.querySelectorAll('.tab')].find((b) => b.textContent?.trim() === label)
  if (!tab) throw new Error(`no such tab: ${label}`)
  ;(tab as HTMLButtonElement).click()
  flushSync()
}

describe('Live degraded resync', () => {
  it('renders the tasks a healthy resync returns', async () => {
    const { target, teardown } = mountLive()
    await settled()

    expect(taskIds(target)).toEqual(['t-1', 't-2'])
    expect(target.querySelector('.stale-note')).toBeNull()

    teardown()
  })

  it('keeps the last good tasks and shows a notice when the payload is unavailable', async () => {
    const { target, teardown } = mountLive()
    await settled()
    expect(taskIds(target)).toEqual(['t-1', 't-2'])

    recentPayload = { tasks: [], lane_count: 4, truncated: false, unavailable: true }
    await nextResync()

    expect(taskIds(target)).toEqual(['t-1', 't-2'])
    expect(target.querySelector('.stale-note')?.textContent).toContain('Live data unavailable')

    teardown()
  })

  // The original bug: a degraded backend that predates the `unavailable` flag
  // answers with a bare array, which threw inside the resync's catch and left
  // the page frozen with nothing on screen to say so.
  it('keeps the last good tasks when an older backend answers with a bare array', async () => {
    const { target, teardown } = mountLive()
    await settled()

    recentPayload = []
    await nextResync()

    expect(taskIds(target)).toEqual(['t-1', 't-2'])
    expect(target.querySelector('.stale-note')).not.toBeNull()

    teardown()
  })

  it('shows the notice when the resync request itself fails', async () => {
    const { target, teardown } = mountLive()
    await settled()

    fetchMock.mockImplementationOnce(async () => {
      throw new Error('network down')
    })
    await nextResync()

    expect(taskIds(target)).toEqual(['t-1', 't-2'])
    expect(target.querySelector('.stale-note')).not.toBeNull()

    teardown()
  })

  // Every tab on this page is fed by the same resync, so the notice belongs
  // above the tab strip rather than inside the Executors panel — an operator
  // watching Arrange or Runtime is looking at equally stale data.
  it('shows the notice on a tab other than Executors, and clears it on recovery', async () => {
    const { target, teardown } = mountLive()
    await settled()
    selectTab(target, 'Arrange')
    expect(target.querySelector('.tl-panel')).toBeNull() // the Executors panel is gone

    recentPayload = { tasks: [], lane_count: 4, unavailable: true }
    await nextResync()

    const notes = target.querySelectorAll('.stale-note')
    expect(notes).toHaveLength(1)
    expect(notes[0].textContent).toContain('Live data unavailable')

    recentPayload = { tasks: [recentTask('t-9', 1)], lane_count: 4 }
    await nextResync()
    expect(target.querySelector('.stale-note')).toBeNull()

    teardown()
  })

  it('clears the notice once a resync succeeds again', async () => {
    const { target, teardown } = mountLive()
    await settled()

    recentPayload = { tasks: [], lane_count: 4, unavailable: true }
    await nextResync()
    expect(target.querySelector('.stale-note')).not.toBeNull()

    recentPayload = { tasks: [recentTask('t-3', 1)], lane_count: 4 }
    await nextResync()

    expect(target.querySelector('.stale-note')).toBeNull()
    expect(taskIds(target)).toEqual(['t-3'])

    teardown()
  })
})

describe('Live cluster view', () => {
  function peer(over: Partial<WorkerPeer>): WorkerPeer {
    return {
      worker_name: 'w1',
      cluster: 'analytics-prod',
      url: 'http://w1:8080/',
      is_current: false,
      ip_address: null,
      debug_port: null,
      debug_url: null,
      ...over,
    }
  }

  function clusterToggle(target: HTMLElement): HTMLButtonElement {
    const btn = target.querySelector('.cluster-toggle')
    if (!btn) throw new Error('no cluster toggle')
    return btn as HTMLButtonElement
  }

  it('stacks a timeline per cluster worker under one toolbar', async () => {
    identity.set(identityWith(timelineConfig(1)))
    workersPayload = [
      peer({ worker_name: 'w1', is_current: true }),
      peer({ worker_name: 'w3', url: 'http://w3:8080/' }),
      peer({ worker_name: 'w2', url: 'http://w2:8080/' }),
      peer({ worker_name: 'elsewhere', cluster: 'analytics-staging' }),
    ]
    const { target, teardown } = mountLive()
    await settled()

    clusterToggle(target).click()
    await settled()

    const names = [...target.querySelectorAll('.peer-name')].map((el) => el.textContent)
    expect(names).toEqual(['w1', 'w2', 'w3'])
    // One shared toolbar for the whole stack.
    expect(target.querySelectorAll('.tl-toolbar')).toHaveLength(1)
    expect(target.querySelectorAll('.tl-panel')).toHaveLength(3)

    teardown()
  })

  it('does not stack a timeline for an offline peer (v1.18 online=false)', async () => {
    identity.set(identityWith(timelineConfig(1)))
    workersPayload = [
      peer({ worker_name: 'w1', is_current: true }),
      peer({ worker_name: 'w2', url: 'http://w2:8080/', online: true }),
      peer({ worker_name: 'w3', url: 'http://w3:8080/', online: false, last_seen_ts: NOW - 120 }),
    ]
    const { target, teardown } = mountLive()
    await settled()

    clusterToggle(target).click()
    await settled()

    const names = [...target.querySelectorAll('.peer-name')].map((el) => el.textContent)
    expect(names).toEqual(['w1', 'w2'])
    expect(target.querySelectorAll('.tl-panel')).toHaveLength(2)

    teardown()
  })

  it('toggles with the "c" key and back off again', async () => {
    const { target, teardown } = mountLive()
    await settled()

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'c' }))
    await settled()
    expect(clusterToggle(target).textContent).toContain('on')

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'c' }))
    await settled()
    expect(clusterToggle(target).textContent).not.toContain('on')
    expect(target.querySelectorAll('.tl-panel')).toHaveLength(1)

    teardown()
  })

  it('says so when the cluster has no other workers', async () => {
    workersPayload = [peer({ is_current: true })]
    const { target, teardown } = mountLive()
    await settled()

    clusterToggle(target).click()
    await settled()

    expect(target.textContent).toContain('No other workers found in this cluster.')

    teardown()
  })
})

describe('Live net readout', () => {
  function pushNetFrame(rx: number, tx: number) {
    socketOpts!.onEvent({
      event: 'net_io',
      ts: NOW,
      metadata: JSON.stringify({ rx_mib_s: rx, tx_mib_s: tx, interval_s: 10 }),
    })
    flushSync()
  }

  it('shows RX/TX rates from net_io frames', async () => {
    const { target, teardown } = mountLive()
    await settled()
    expect(target.textContent).not.toContain('Net:')

    socketOpts!.onStatus('connected')
    flushSync()
    pushNetFrame(12.34, 0.56)

    expect(target.textContent).toContain('Net: RX 12.3 · TX 0.6 MiB/s')

    teardown()
  })

  it('drops the readout when the stream disconnects', async () => {
    const { target, teardown } = mountLive()
    await settled()
    socketOpts!.onStatus('connected')
    flushSync()
    pushNetFrame(1.0, 2.0)
    expect(target.textContent).toContain('Net: RX 1.0')

    // A frozen rate would read as current — it must vanish with the stream.
    socketOpts!.onStatus('disconnected')
    flushSync()
    expect(target.textContent).not.toContain('Net:')

    teardown()
  })

  it('ignores malformed net_io metadata', async () => {
    const { target, teardown } = mountLive()
    await settled()
    socketOpts!.onStatus('connected')
    flushSync()

    socketOpts!.onEvent({ event: 'net_io', ts: NOW, metadata: 'not json' })
    flushSync()

    expect(target.textContent).not.toContain('Net:')

    teardown()
  })

  it('shows the NFS readout when the frame carries the NFS pair', async () => {
    const { target, teardown } = mountLive()
    await settled()
    socketOpts!.onStatus('connected')
    flushSync()

    socketOpts!.onEvent({
      event: 'net_io',
      ts: NOW,
      metadata: JSON.stringify({
        rx_mib_s: 1.5,
        tx_mib_s: 0.5,
        nfs_read_mib_s: 850.25,
        nfs_write_mib_s: 0.75,
      }),
    })
    flushSync()

    expect(target.textContent).toContain('NFS: R 850.3 · W 0.8 MiB/s')
    expect(target.textContent).toContain('Net: RX 1.5 · TX 0.5 MiB/s')

    teardown()
  })

  it('hides only the NFS readout when a later frame omits the pair', async () => {
    // The NFS mount can vanish (remount interval, unmount) while the
    // interface counters keep streaming — the readouts are independent.
    const { target, teardown } = mountLive()
    await settled()
    socketOpts!.onStatus('connected')
    flushSync()

    socketOpts!.onEvent({
      event: 'net_io',
      ts: NOW,
      metadata: JSON.stringify({
        rx_mib_s: 1.0,
        tx_mib_s: 0.5,
        nfs_read_mib_s: 10,
        nfs_write_mib_s: 1,
      }),
    })
    flushSync()
    expect(target.textContent).toContain('NFS: R 10.0')

    socketOpts!.onEvent({
      event: 'net_io',
      ts: NOW,
      metadata: JSON.stringify({ rx_mib_s: 2.0, tx_mib_s: 0.5 }),
    })
    flushSync()

    expect(target.textContent).not.toContain('NFS:')
    expect(target.textContent).toContain('Net: RX 2.0')

    teardown()
  })
})

describe('Live offload readout', () => {
  it('stays hidden when the overview has no offload key (Go backends)', async () => {
    const { target, teardown } = mountLive()
    await settled()

    expect(target.textContent).not.toContain('Offload:')

    teardown()
  })

  it('shows running/queued/threads when the overview carries offload', async () => {
    overviewPayload = { ...defaultOverview(), offload: { running: 1, queued: 3, max_threads: 2 } }
    const { target, teardown } = mountLive()
    await settled()

    expect(target.textContent).toContain('Offload: 1 / 2 busy, 3 queued')

    teardown()
  })

  it('updates on the resync tick and hides again when the key disappears', async () => {
    const { target, teardown } = mountLive()
    await settled()
    expect(target.textContent).not.toContain('Offload:')

    // The next 5s resync re-reads the overview strip.
    overviewPayload = { ...defaultOverview(), offload: { running: 0, queued: 0, max_threads: 4 } }
    await nextResync()
    expect(target.textContent).toContain('Offload: 0 / 4 busy, 0 queued')

    // Key gone again (say, after a fail-over to a backend without a pool):
    // a stale readout must not survive it.
    overviewPayload = defaultOverview()
    await nextResync()
    expect(target.textContent).not.toContain('Offload:')

    teardown()
  })
})

describe('Live pool readout', () => {
  it('renders the pool maximum from the overview', async () => {
    const { target, teardown } = mountLive()
    await settled()

    expect(target.textContent).toContain('Pool: 0 / 4 slots')

    teardown()
  })

  it('renders an em dash while the pool maximum is unknown', async () => {
    // The overview is pool_max's ONLY source. When it never lands (wedged
    // loop during an incident), a literal 0 read as a broken pool —
    // "Pool: 10 / 0 slots" — in production screenshots.
    overviewPayload = { ...defaultOverview(), pool_max: 0 }
    const { target, teardown } = mountLive()
    await settled()

    expect(target.textContent).toContain('Pool: 0 / — slots')

    teardown()
  })
})

describe('Live throughput routing', () => {
  it('feeds throughput frames into the timeline track', async () => {
    const { target, teardown } = mountLive()
    await settled()
    socketOpts!.onStatus('connected')
    flushSync()
    expect(target.querySelector('.tp-now')).toBeNull()

    const win = { throughput: 41_250_000, task_rate: 9, tasks: 9 }
    socketOpts!.onEvent({
      event: 'throughput',
      ts: NOW,
      metadata: JSON.stringify({
        windows: { '1': win, '5': win, '30': win, '60': win, '300': win },
      }),
    })
    flushSync()

    expect(target.querySelector('.tl-throughput polyline')).not.toBeNull()
    expect(target.querySelector('.tp-now')?.textContent).toContain('41.3M/s')

    teardown()
  })
})

describe('Live host pressure routing', () => {
  it('parses resource_sample frames and hands them to the Runtime tab', async () => {
    // The shared fetch mock answers /runtime/health with [] (its generic
    // fallback); the Runtime tab needs a real snapshot to render at all.
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/runtime/health')) {
        return okJson({
          enabled: true,
          state: 'healthy',
          unit_label: 'tasks',
          current_lag_ms: 1,
          heartbeat_age_ms: 1,
          window: [],
          recent_stalls: [],
        })
      }
      if (url.includes('/recent-tasks')) return okJson(recentPayload)
      if (url.includes('/live/overview')) return okJson(overviewPayload)
      return okJson([])
    })
    const { target, teardown } = mountLive()
    await settled()
    socketOpts!.onStatus('connected')
    flushSync()

    socketOpts!.onEvent({
      event: 'resource_sample',
      ts: NOW,
      metadata: JSON.stringify({ load1: 9.9, load5: 5.5, psi_cpu_some_avg10: 12.0 }),
    })
    flushSync()

    // Open the Runtime tab; its Host section must show the pushed reading
    // without waiting for any fetch.
    selectTab(target, 'Runtime')
    await settled()
    await settled()

    expect(target.textContent).toContain('9.9 / 5.5')
    expect(target.textContent).toContain('12.0%')

    teardown()
  })
})
