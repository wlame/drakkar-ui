// The memory window note in the Event History header: with the recorder off
// the feed reads only the memory store, so the header says how far back it
// reaches; with the recorder on, or no capabilities, it shows no note.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import History from './History.svelte'
import { identity } from '../lib/config'

const fetchMock = vi.fn()

const mounted: { target: HTMLElement; component: Record<string, unknown> }[] = []

// The page fetches the dashboard and the events in onMount; drain the
// microtask queue before asserting on the header.
async function renderPage() {
  // The events route answers a list of rows, the dashboard an object.
  fetchMock.mockImplementation(async (url: string) => {
    const body = String(url).includes('/events') ? [] : { partitions: [] }
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => '',
    } as unknown as Response
  })
  const target = document.createElement('div')
  document.body.appendChild(target)
  const component = mount(History, { target, props: { params: {} } })
  mounted.push({ target, component })
  for (let i = 0; i < 3; i++) {
    flushSync()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  flushSync()
  return target
}

const heading = (target: HTMLElement) => target.querySelector('h1')?.textContent ?? ''

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  for (const { target, component } of mounted.splice(0)) {
    unmount(component)
    target.remove()
  }
  vi.unstubAllGlobals()
  identity.set(null)
})

describe('Event History memory window note', () => {
  it('says the window is in memory when the recorder is off', async () => {
    identity.set({
      worker_id: 'w',
      cluster: null,
      config_summary: '',
      capabilities: {
        recorder: { enabled: false, provider: 'none', history_search: false },
        memory: { enabled: true, window_seconds: 120, max_rows: 12000 },
      },
    })
    const target = await renderPage()
    expect(heading(target)).toContain('Event History')
    expect(heading(target)).toContain('last 2 minutes, in memory')
  })

  it('shows no note when the recorder runs or capabilities are missing', async () => {
    expect(heading(await renderPage())).not.toContain('in memory')
    identity.set({
      worker_id: 'w',
      cluster: null,
      config_summary: '',
      capabilities: { recorder: { enabled: true } },
    })
    expect(heading(await renderPage())).not.toContain('in memory')
  })
})
