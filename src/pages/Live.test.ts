// Mounts the real Live page against a stubbed backend. Two behaviors are
// pinned here: a degraded /recent-tasks response must leave the last good
// state on screen behind a visible notice (it used to freeze the page in
// silence), and the finished table must follow the configured timeline depth
// instead of a fixed cap.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import Live from './Live.svelte'
import { identity } from '../lib/config'
import type { Identity, RecentTask, TimelineConfig } from '../lib/types'

// Stubbed rather than opening a real socket: happy-dom's WebSocket would try
// to connect, and these tests drive the page entirely through its HTTP resync.
vi.mock('../lib/ws', () => ({
  createLiveSocket: vi.fn(() => ({
    close: vi.fn(),
    setFrozen: vi.fn(),
    setSuspended: vi.fn(),
  })),
}))

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

const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input)
  if (url.includes('/recent-tasks')) return okJson(recentPayload)
  if (url.includes('/live/overview')) {
    return okJson({
      pool_max: 4,
      pool_active: 0,
      pool_waiting: 0,
      partition_count: 1,
      max_ui_rows: 5000,
      hook_flags: { task_complete: false, message_complete: false, window_complete: false },
    })
  }
  return okJson([])
})

beforeEach(() => {
  // Fake timers from before mount: the 5s resync interval is created during
  // mount, and an interval created under real timers stays invisible to a
  // clock installed afterwards.
  vi.useFakeTimers()
  recentPayload = { tasks: [recentTask('t-1', 2), recentTask('t-2', 1)], lane_count: 4 }
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
  identity.set(null)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  identity.set(null)
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

function taskIds(target: HTMLElement): string[] {
  return [...target.querySelectorAll('tbody tr td:first-child')].map((td) => td.textContent ?? '')
}

// The timeline renders its own <h2>, so pick the finished table's by its text.
function finishedHeading(target: HTMLElement): string {
  const h = [...target.querySelectorAll('h2')].find((el) => el.textContent?.includes('Finished'))
  return h?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
}

describe('Live degraded resync', () => {
  it('renders the finished tasks a healthy resync returns', async () => {
    const { target, teardown } = mountLive()
    await settled()

    expect(taskIds(target)).toEqual(['t-2', 't-1'])
    expect(target.querySelector('.stale-note')).toBeNull()

    teardown()
  })

  it('keeps the last good tasks and shows a notice when the payload is unavailable', async () => {
    const { target, teardown } = mountLive()
    await settled()
    expect(taskIds(target)).toEqual(['t-2', 't-1'])

    recentPayload = { tasks: [], lane_count: 4, truncated: false, unavailable: true }
    await nextResync()

    expect(taskIds(target)).toEqual(['t-2', 't-1'])
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

    expect(taskIds(target)).toEqual(['t-2', 't-1'])
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

    expect(taskIds(target)).toEqual(['t-2', 't-1'])
    expect(target.querySelector('.stale-note')).not.toBeNull()

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

describe('Live finished-table cap', () => {
  it('follows the configured timeline depth (history_factor x lanes)', async () => {
    identity.set(identityWith(timelineConfig(1)))
    recentPayload = {
      tasks: [recentTask('t-1', 3), recentTask('t-2', 2), recentTask('t-3', 1)],
      lane_count: 2,
    }
    const { target, teardown } = mountLive()
    await settled()

    expect(taskIds(target)).toEqual(['t-3', 't-2'])
    expect(finishedHeading(target)).toContain('newest 2 shown')

    teardown()
  })

  it('keeps the legacy cap when the backend serves no timeline config', async () => {
    recentPayload = {
      tasks: Array.from({ length: 201 }, (_, i) => recentTask(`t-${i}`, 201 - i)),
      lane_count: 4,
    }
    const { target, teardown } = mountLive()
    await settled()

    expect(target.querySelectorAll('tbody tr')).toHaveLength(200)
    expect(finishedHeading(target)).toContain('newest 200 shown')

    teardown()
  })
})
