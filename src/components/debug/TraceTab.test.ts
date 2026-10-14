// Message trace (contract v1.23): by default the serving worker's own files;
// with "search history" also its cluster's sealed history (history=1), the
// two answers merged without duplicates.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import TraceTab from './TraceTab.svelte'

function traceRow(id: number, ts: number, worker: string, event: string) {
  return {
    id,
    ts,
    worker_name: worker,
    event,
    partition: 0,
    offset: 1,
    task_id: null,
    args: null,
    stdout: null,
    stderr: null,
    exit_code: null,
    duration: null,
    output_topic: null,
    metadata: null,
    pid: null,
    labels: null,
    origin: 'kafka',
    client_name: null,
    request_id: null,
  }
}

const own = [traceRow(1, 100, 'w-1', 'consumed'), traceRow(2, 101, 'w-1', 'committed')]
const history = [traceRow(7, 90, 'w-2', 'consumed'), traceRow(1, 100, 'w-1', 'consumed')]

function stubFetch() {
  const urls: string[] = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    urls.push(url)
    if (url.includes('/debug/trace?')) {
      return new Response(JSON.stringify(url.includes('history=1') ? history : own), {
        status: 200,
      })
    }
    return new Response('[]', { status: 200 })
  })
  return { fetchMock, urls }
}

async function settled() {
  for (let i = 0; i < 4; i++) {
    flushSync()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  flushSync()
}

function renderMounted() {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(TraceTab, { target, props: { prefill: null } })
  return {
    target,
    cleanup: () => {
      unmount(app)
      target.remove()
    },
  }
}

async function trace(target: HTMLElement, value: string) {
  const input = target.querySelector<HTMLInputElement>('.bar input:not([type=checkbox])')!
  input.value = value
  input.dispatchEvent(new Event('input'))
  flushSync()
  ;[...target.querySelectorAll('button')].find((b) => b.textContent === 'Trace')!.click()
  await settled()
}

describe('TraceTab history search (v1.23)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('searches only the own files by default', async () => {
    const { fetchMock, urls } = stubFetch()
    vi.stubGlobal('fetch', fetchMock)
    const { target, cleanup } = renderMounted()
    await settled()

    await trace(target, '0:1')

    expect(urls.filter((u) => u.includes('/debug/trace?'))).toEqual([
      '/api/v1/debug/trace?partition=0&offset=1',
    ])
    expect(target.textContent).toContain('2 events')
    cleanup()
  })

  it('adds the sealed history with history=1 and merges the rows without duplicates', async () => {
    const { fetchMock, urls } = stubFetch()
    vi.stubGlobal('fetch', fetchMock)
    const { target, cleanup } = renderMounted()
    await settled()

    target.querySelector<HTMLInputElement>('.bar input[type=checkbox]')!.click()
    flushSync()
    await trace(target, '0:1')

    expect(urls.filter((u) => u.includes('/debug/trace?')).sort()).toEqual([
      '/api/v1/debug/trace?partition=0&offset=1',
      '/api/v1/debug/trace?partition=0&offset=1&history=1',
    ])
    expect(target.textContent).toContain('3 events')
    cleanup()
  })
})

// The cluster fan-out (v1.23 part 3): the own-file reads go to every
// same-cluster worker that is not offline; rows are tagged by worker (row
// ids repeat across workers' files); a worker that does not answer is
// listed instead of failing the trace.
const workers = [
  {
    worker_name: 'w-1',
    cluster: 'search',
    url: 'http://w-1:8080/',
    is_current: true,
    online: true,
  },
  {
    worker_name: 'w-2',
    cluster: 'search',
    url: 'http://w-2:8080/',
    is_current: false,
    online: true,
  },
  {
    worker_name: 'w-3',
    cluster: 'search',
    url: 'http://w-3:8080/',
    is_current: false,
    online: null,
  },
  {
    worker_name: 'w-off',
    cluster: 'search',
    url: 'http://w-off:8080/',
    is_current: false,
    online: false,
  },
  {
    worker_name: 'w-other',
    cluster: 'index',
    url: 'http://w-other:8080/',
    is_current: false,
    online: true,
  },
]

function stubClusterFetch() {
  const urls: string[] = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    urls.push(url)
    if (url.endsWith('/api/v1/workers'))
      return new Response(JSON.stringify(workers), { status: 200 })
    if (url.startsWith('http://w-3:8080/')) throw new TypeError('Failed to fetch')
    if (url.includes('/debug/trace?') || url.includes('/debug/trace-by-label?')) {
      const rows = url.startsWith('http://w-2:8080/')
        ? [traceRow(1, 102, 'w-2', 'task_started'), traceRow(2, 103, 'w-2', 'task_completed')]
        : own
      return new Response(JSON.stringify(rows), { status: 200 })
    }
    if (url.includes('/debug/label-keys')) return new Response('["request_id"]', { status: 200 })
    return new Response('[]', { status: 200 })
  })
  return { fetchMock, urls }
}

describe('TraceTab cluster fan-out (v1.23)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('asks every same-cluster worker that is not offline and lists the one that did not answer', async () => {
    const { fetchMock, urls } = stubClusterFetch()
    vi.stubGlobal('fetch', fetchMock)
    const { target, cleanup } = renderMounted()
    await settled()

    await trace(target, '0:1')

    expect(urls.filter((u) => u.includes('/debug/trace?')).sort()).toEqual([
      '/api/v1/debug/trace?partition=0&offset=1',
      'http://w-2:8080/api/v1/debug/trace?partition=0&offset=1',
      'http://w-3:8080/api/v1/debug/trace?partition=0&offset=1',
    ])
    // Row ids 1 and 2 exist on both w-1 and w-2: all four rows are shown.
    expect(target.textContent).toContain('4 events')
    expect(target.querySelectorAll('tbody tr')).toHaveLength(4)
    expect(target.querySelector('.unreachable')?.textContent).toContain('w-3 (unreachable)')
    cleanup()
  })

  it('reads the sealed history once, on this worker only', async () => {
    const { fetchMock, urls } = stubClusterFetch()
    vi.stubGlobal('fetch', fetchMock)
    const { target, cleanup } = renderMounted()
    await settled()

    target.querySelector<HTMLInputElement>('.bar input[type=checkbox]')!.click()
    flushSync()
    await trace(target, '0:1')

    expect(urls.filter((u) => u.includes('history=1'))).toEqual([
      '/api/v1/debug/trace?partition=0&offset=1&history=1',
    ])
    cleanup()
  })

  it('fans the label trace out the same way', async () => {
    const { fetchMock, urls } = stubClusterFetch()
    vi.stubGlobal('fetch', fetchMock)
    const { target, cleanup } = renderMounted()
    await settled()

    const valueInput = target.querySelector<HTMLInputElement>('.label-row input')!
    valueInput.value = 'abc'
    valueInput.dispatchEvent(new Event('input'))
    flushSync()
    target.querySelector<HTMLButtonElement>('.label-row button')!.click()
    await settled()

    expect(urls.filter((u) => u.includes('/debug/trace-by-label?')).sort()).toEqual([
      '/api/v1/debug/trace-by-label?key=request_id&value=abc',
      'http://w-2:8080/api/v1/debug/trace-by-label?key=request_id&value=abc',
      'http://w-3:8080/api/v1/debug/trace-by-label?key=request_id&value=abc',
    ])
    expect(target.textContent).toContain('4 events')
    cleanup()
  })
})

describe('TraceTab search order', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('never lets an older, slower search replace the newer one', async () => {
    let releaseFirst: (() => void) | null = null
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/debug/trace?partition=0&offset=1')) {
          // The first search answers only after the second one has.
          await new Promise<void>((resolve) => (releaseFirst = resolve))
          return new Response(JSON.stringify([traceRow(1, 100, 'w-1', 'consumed')]), {
            status: 200,
          })
        }
        if (url.includes('/debug/trace?partition=0&offset=2')) {
          return new Response(JSON.stringify(own), { status: 200 })
        }
        return new Response('[]', { status: 200 })
      }),
    )
    const { target, cleanup } = renderMounted()
    await settled()

    await trace(target, '0:1')
    await trace(target, '0:2')
    expect(target.textContent).toContain('2 events')
    releaseFirst!()
    await settled()

    expect(target.textContent).toContain('2 events')
    expect(target.querySelectorAll('tbody tr')).toHaveLength(2)
    cleanup()
  })
})
