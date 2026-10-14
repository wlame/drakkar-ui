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
