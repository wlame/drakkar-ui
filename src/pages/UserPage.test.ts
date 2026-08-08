// Regression: two widgets sharing a title must still render both cards. The
// wire contract (UIPageWidget) has no unique id and does not guarantee
// title uniqueness within a page, so the {#each} must key on the array
// index, not widget.title — keying on title throws Svelte's duplicate-key
// error the moment two widgets share one.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import UserPage from './UserPage.svelte'
import { loadUiPages } from '../lib/pages'
import { setLinkBases } from '../lib/enrich'
import type { TaskResult, UIPage } from '../lib/types'

// Stubbed rather than driving a real WebSocket: happy-dom's WebSocket would
// attempt a real connection, and the live-refresh tests below only need to
// inspect what UserPage passes to createLiveSocket and invoke the captured
// onEvent — never an actual socket.
vi.mock('../lib/ws', () => ({
  createLiveSocket: vi.fn(() => ({ close: vi.fn() })),
}))
import { createLiveSocket } from '../lib/ws'
import type { WsEvent } from '../lib/types'

const mockedCreateLiveSocket = vi.mocked(createLiveSocket)

const fetchMock = vi.fn()

function okJson(data: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => data,
    text: async () => JSON.stringify(data),
  } as unknown as Response
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  mockedCreateLiveSocket.mockClear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

// Lets a widget's async reload() (fetchWidgetRows/fetchStatValue, each behind
// an awaited fetch) resolve before assertions run — same drain loop
// RuntimeTab.test.ts uses for its own $effect-driven async reload.
async function settled() {
  for (let i = 0; i < 4; i++) {
    flushSync()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  flushSync()
}

// Same drain as settled(), but for use once vi.useFakeTimers() is active:
// setTimeout(…, 0) never resolves against a fake clock unless the clock is
// advanced, and a setInterval created under real timers (e.g. during mount,
// before the test switches to fake ones) never becomes visible to it either
// — so the stat-interval tests below flip to fake timers before mounting
// and drain with this instead of settled().
async function settledFake() {
  for (let i = 0; i < 4; i++) {
    flushSync()
    await vi.advanceTimersByTimeAsync(0)
  }
  flushSync()
}

describe('UserPage widget list', () => {
  it('renders both cards when two widgets share a title', async () => {
    const page: UIPage = {
      slug: 'orders',
      title: 'Orders',
      widgets: [
        { title: 'Summary', view: 'stat', source: { kind: 'field' } },
        { title: 'Summary', view: 'table', source: { kind: 'field' } },
      ],
    }
    fetchMock.mockResolvedValue(okJson([page]))
    await loadUiPages()

    const target = document.createElement('div')
    document.body.appendChild(target)
    const app = mount(UserPage, { target, props: { params: { slug: 'orders' } } })
    flushSync()

    const widgets = target.querySelectorAll('.widget')
    expect(widgets).toHaveLength(2)
    expect([...widgets].map((w) => w.querySelector('h2')?.textContent)).toEqual([
      'Summary',
      'Summary',
    ])

    unmount(app)
    target.remove()
  })
})

describe('UserPage widget rendering', () => {
  it('renders a table widget with declared columns and a resolved link', async () => {
    const page: UIPage = {
      slug: 'orders',
      title: 'Orders',
      widgets: [
        {
          title: 'Recent tasks',
          view: 'table',
          source: { kind: 'tasks', limit: 50 },
          columns: [{ key: 'task_id', label: 'Task', link_template: '{tracing}/task/{value}' }],
        },
      ],
    }
    const taskRows: TaskResult[] = [
      {
        ts: 1,
        task_id: 't-42',
        partition: 0,
        source_offsets: null,
        hook_duration: null,
        exec_duration: 0.1,
        status: 'completed',
        exit_code: 0,
        output_message_count: 1,
      },
    ]
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/live/task-results')) return okJson(taskRows)
      return okJson([page])
    })
    setLinkBases({ tracing: 'https://tracing.example.com' })
    await loadUiPages()

    const target = document.createElement('div')
    document.body.appendChild(target)
    const app = mount(UserPage, { target, props: { params: { slug: 'orders' } } })
    await settled()

    const headers = [...target.querySelectorAll('th')].map((th) => th.textContent?.trim())
    expect(headers).toEqual(['Task'])

    const link = target.querySelector('a') as HTMLAnchorElement
    expect(link).not.toBeNull()
    expect(link.getAttribute('href')).toBe('https://tracing.example.com/task/t-42')
    expect(link.textContent).toBe('t-42')

    unmount(app)
    target.remove()
    setLinkBases({})
  })

  it('renders the unsupported-widget placeholder for an unknown view', async () => {
    const page: UIPage = {
      slug: 'orders',
      title: 'Orders',
      widgets: [{ title: 'Trend', view: 'sparkline', source: { kind: 'tasks' } }],
    }
    fetchMock.mockResolvedValue(okJson([page]))
    await loadUiPages()

    const target = document.createElement('div')
    document.body.appendChild(target)
    const app = mount(UserPage, { target, props: { params: { slug: 'orders' } } })
    await settled()

    expect(target.textContent).toContain(
      "This widget needs a newer UI (unsupported view 'sparkline').",
    )

    unmount(app)
    target.remove()
  })

  it('names the source kind, not the view, when the view is known but the source is not', async () => {
    const page: UIPage = {
      slug: 'orders',
      title: 'Orders',
      widgets: [{ title: 'Mystery', view: 'table', source: { kind: 'crystal-ball' } }],
    }
    fetchMock.mockResolvedValue(okJson([page]))
    await loadUiPages()

    const target = document.createElement('div')
    document.body.appendChild(target)
    const app = mount(UserPage, { target, props: { params: { slug: 'orders' } } })
    await settled()

    expect(target.textContent).toContain(
      "This widget needs a newer UI (unsupported source 'crystal-ball').",
    )
    expect(target.textContent).not.toContain("unsupported view 'table'")

    unmount(app)
    target.remove()
  })
})

describe('UserPage live refresh', () => {
  // Counts fetch calls whose URL contains `pattern`, so a test can assert a
  // specific widget's data source refetched without caring about the exact
  // query string.
  function callsTo(pattern: string): number {
    return fetchMock.mock.calls.filter(([input]) => String(input).includes(pattern)).length
  }

  function stubEndpoints(page: UIPage) {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/pages')) return okJson([page])
      if (url.includes('/events')) return okJson([])
      if (url.includes('/live/task-results')) return okJson([])
      if (url.includes('/debug/metrics')) return okJson([])
      return okJson([])
    })
  }

  it('subscribes over the union of its widgets’ refresh event types', async () => {
    const page: UIPage = {
      slug: 'orders',
      title: 'Orders',
      widgets: [
        { title: 'Annotations', view: 'table', source: { kind: 'annotations' } },
        { title: 'Recent tasks', view: 'table', source: { kind: 'tasks' } },
      ],
    }
    stubEndpoints(page)
    await loadUiPages()

    const target = document.createElement('div')
    document.body.appendChild(target)
    const app = mount(UserPage, { target, props: { params: { slug: 'orders' } } })
    flushSync()

    expect(mockedCreateLiveSocket).toHaveBeenCalledTimes(1)
    const opts = mockedCreateLiveSocket.mock.calls[0][0]
    expect(opts.eventTypes).toEqual(
      expect.arrayContaining(['annotation', 'task_complete', 'task_completed', 'task_failed']),
    )

    unmount(app)
    target.remove()
  })

  it('opens no socket when every widget is a stat (empty event-type union)', async () => {
    const page: UIPage = {
      slug: 'orders',
      title: 'Orders',
      widgets: [{ title: 'Total', view: 'stat', source: { kind: 'metrics', metric: 'm' } }],
    }
    stubEndpoints(page)
    await loadUiPages()

    const target = document.createElement('div')
    document.body.appendChild(target)
    const app = mount(UserPage, { target, props: { params: { slug: 'orders' } } })
    flushSync()

    expect(mockedCreateLiveSocket).not.toHaveBeenCalled()

    unmount(app)
    target.remove()
  })

  it('coalesces a burst of matching events into one debounced refetch', async () => {
    const page: UIPage = {
      slug: 'orders',
      title: 'Orders',
      widgets: [{ title: 'Annotations', view: 'table', source: { kind: 'annotations' } }],
    }
    stubEndpoints(page)
    await loadUiPages()

    const target = document.createElement('div')
    document.body.appendChild(target)
    const app = mount(UserPage, { target, props: { params: { slug: 'orders' } } })
    await settled()

    const before = callsTo('/events')
    const opts = mockedCreateLiveSocket.mock.calls[0][0]

    vi.useFakeTimers()
    // Three events inside one burst: still only one refetch once the
    // debounce window elapses.
    opts.onEvent({ event: 'annotation', ts: 1 } as WsEvent)
    opts.onEvent({ event: 'annotation', ts: 2 } as WsEvent)
    opts.onEvent({ event: 'annotation', ts: 3 } as WsEvent)
    vi.advanceTimersByTime(499)
    expect(callsTo('/events')).toBe(before) // debounce hasn't fired yet
    vi.advanceTimersByTime(1)
    vi.useRealTimers()
    flushSync()
    await settled()

    expect(callsTo('/events')).toBe(before + 1)

    unmount(app)
    target.remove()
  })

  it('marks every watched widget pending on a reported gap, refetching after the debounce', async () => {
    // A gap means the server dropped frames for us — any watched widget
    // could have missed an update, so onGap must fan out to all of them,
    // not just the one nearest in the widget list.
    const page: UIPage = {
      slug: 'orders',
      title: 'Orders',
      widgets: [
        { title: 'Annotations', view: 'table', source: { kind: 'annotations' } },
        { title: 'Recent tasks', view: 'table', source: { kind: 'tasks' } },
      ],
    }
    stubEndpoints(page)
    await loadUiPages()

    const target = document.createElement('div')
    document.body.appendChild(target)
    const app = mount(UserPage, { target, props: { params: { slug: 'orders' } } })
    await settled()

    const eventsBefore = callsTo('/events')
    const tasksBefore = callsTo('/live/task-results')
    const opts = mockedCreateLiveSocket.mock.calls[0][0]

    vi.useFakeTimers()
    opts.onGap?.(3)
    vi.advanceTimersByTime(499)
    expect(callsTo('/events')).toBe(eventsBefore) // debounce hasn't fired yet
    expect(callsTo('/live/task-results')).toBe(tasksBefore)
    vi.advanceTimersByTime(1)
    vi.useRealTimers()
    flushSync()
    await settled()

    expect(callsTo('/events')).toBe(eventsBefore + 1)
    expect(callsTo('/live/task-results')).toBe(tasksBefore + 1)

    unmount(app)
    target.remove()
  })

  it('only bumps the widget whose refresh event types match the incoming event', async () => {
    const page: UIPage = {
      slug: 'orders',
      title: 'Orders',
      widgets: [
        { title: 'Annotations', view: 'table', source: { kind: 'annotations' } },
        { title: 'Recent tasks', view: 'table', source: { kind: 'tasks' } },
      ],
    }
    stubEndpoints(page)
    await loadUiPages()

    const target = document.createElement('div')
    document.body.appendChild(target)
    const app = mount(UserPage, { target, props: { params: { slug: 'orders' } } })
    await settled()

    const eventsBefore = callsTo('/events')
    const tasksBefore = callsTo('/live/task-results')
    const opts = mockedCreateLiveSocket.mock.calls[0][0]

    vi.useFakeTimers()
    opts.onEvent({ event: 'annotation', ts: 1 } as WsEvent)
    vi.advanceTimersByTime(500)
    vi.useRealTimers()
    flushSync()
    await settled()

    expect(callsTo('/events')).toBe(eventsBefore + 1)
    expect(callsTo('/live/task-results')).toBe(tasksBefore) // untouched

    unmount(app)
    target.remove()
  })

  it('refreshes a stat widget on a 30s interval instead of via the socket', async () => {
    const page: UIPage = {
      slug: 'orders',
      title: 'Orders',
      widgets: [{ title: 'Total', view: 'stat', source: { kind: 'metrics', metric: 'm' } }],
    }
    stubEndpoints(page)
    await loadUiPages()

    // The interval is created at mount, so fake timers must already be
    // active — switching afterward would leave a real interval that
    // advancing the fake clock can never see (settledFake's doc comment).
    vi.useFakeTimers()
    const target = document.createElement('div')
    document.body.appendChild(target)
    const app = mount(UserPage, { target, props: { params: { slug: 'orders' } } })
    await settledFake()

    const before = callsTo('/debug/metrics')

    await vi.advanceTimersByTimeAsync(29_999)
    expect(callsTo('/debug/metrics')).toBe(before)
    await vi.advanceTimersByTimeAsync(1)
    await settledFake()

    expect(callsTo('/debug/metrics')).toBe(before + 1)

    unmount(app)
    target.remove()
  })

  it('closes the socket and stops the stat interval on unmount', async () => {
    const page: UIPage = {
      slug: 'orders',
      title: 'Orders',
      widgets: [
        { title: 'Annotations', view: 'table', source: { kind: 'annotations' } },
        { title: 'Total', view: 'stat', source: { kind: 'metrics', metric: 'm' } },
      ],
    }
    stubEndpoints(page)
    await loadUiPages()

    vi.useFakeTimers()
    const target = document.createElement('div')
    document.body.appendChild(target)
    const app = mount(UserPage, { target, props: { params: { slug: 'orders' } } })
    await settledFake()

    const socketReturn = mockedCreateLiveSocket.mock.results[0].value as { close: () => void }
    const closeSpy = vi.mocked(socketReturn.close)
    const before = callsTo('/debug/metrics')

    unmount(app)

    expect(closeSpy).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(30_000)
    expect(callsTo('/debug/metrics')).toBe(before) // interval was cleared, not left running

    target.remove()
  })
})
