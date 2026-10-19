// Databases tab (contract v1.23): this worker's own files and the shared
// history folders, rendered against a stubbed fetch. Covers the own table,
// one foldable block per history folder, meta-based statistics, downloads
// and merge by path, the worker filter, and the "not available" answer for
// a backend that predates v1.23.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import DatabasesTab from './DatabasesTab.svelte'
import type { DatabasesResponse, HistoryFile } from '../../lib/types'

function sealed(name: string, worker: string, events: Record<string, number> | null): HistoryFile {
  return {
    path: `history/search/${name}`,
    name,
    kind: 'sealed',
    size_bytes: 4096,
    modified_at: '2026-10-14T09:00:02.410000Z',
    meta:
      events === null
        ? null
        : {
            schema: 1,
            worker,
            instance: '9c41e0b27fd34a1e',
            cluster: 'search',
            first_event_ts: '2026-10-14T08:00:00.000000Z',
            last_event_ts: '2026-10-14T08:59:59.871000Z',
            sealed_at: '2026-10-14T09:00:02.410000Z',
            size_bytes: 4096,
            tables: { events: 7 },
            event_types: events,
          },
  }
}

const body: DatabasesResponse = {
  own: [
    {
      filename: 'w-1-2026-10-14__09_00_00.db',
      worker_name: 'w-1',
      cluster_name: 'search',
      kind: 'live',
      event_count: 12,
      event_counts: { task_started: 6, task_completed: 6 },
      first_event_ts: 1760432400,
      last_event_ts: 1760432460,
      size_bytes: 8192,
    },
    {
      filename: 'w-1-2026-10-14__08_00_00.db',
      worker_name: 'w-1',
      cluster_name: 'search',
      kind: 'backlog',
      event_count: 3,
      event_counts: { consumed: 3 },
      first_event_ts: 1760428800,
      last_event_ts: 1760428900,
      size_bytes: 2048,
    },
  ],
  history: {
    folders: [
      {
        folder: 'history/search',
        kind: 'history',
        cluster: 'search',
        files: [
          sealed('w-1-2026-10-14__07_00_00.db', 'w-1', { task_started: 4, task_completed: 3 }),
          sealed('w-2-2026-10-14__07_00_00.db', 'w-2', { consumed: 5 }),
          sealed('w-3-2026-10-14__07_00_00.db', 'w-3', null),
          {
            path: 'history/search/search-2026-10-12_00-00__2026-10-13_00-00.db.gz',
            name: 'search-2026-10-12_00-00__2026-10-13_00-00.db.gz',
            kind: 'archive',
            size_bytes: 3 * 1024 * 1024,
            modified_at: '2026-10-13T02:00:00.000000Z',
            meta: null,
          },
        ],
      },
      {
        folder: 'merged',
        kind: 'merged',
        cluster: null,
        files: [
          {
            path: 'merged/merged-2026-10-14__10_00_00-0123456789abcdef.db',
            name: 'merged-2026-10-14__10_00_00-0123456789abcdef.db',
            kind: 'merged',
            size_bytes: 1024,
            modified_at: '2026-10-14T10:00:00.000000Z',
            meta: null,
          },
        ],
      },
    ],
  },
}

let lastMergeBody: unknown = null

function stubFetch(databases: unknown = body) {
  lastMergeBody = null
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/debug/merge')) {
      lastMergeBody = JSON.parse(String(init?.body))
      return new Response(
        JSON.stringify({
          filename: 'merged-2026-10-14__11_00_00-fedcba9876543210.db',
          path: 'merged/merged-2026-10-14__11_00_00-fedcba9876543210.db',
          worker_count: 2,
          event_count: 12,
          state_count: 0,
          cluster_name: 'search',
          source_files: [],
        }),
        { status: 200 },
      )
    }
    if (url.includes('/debug/databases')) {
      return new Response(JSON.stringify(databases), { status: 200 })
    }
    return new Response('[]', { status: 200 })
  })
}

// Drains the onMount load() chain (an awaited fetch + json()).
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
  const app = mount(DatabasesTab, { target })
  return {
    target,
    cleanup: () => {
      unmount(app)
      target.remove()
    },
  }
}

function row(target: HTMLElement, name: string): HTMLTableRowElement {
  const found = [...target.querySelectorAll<HTMLTableRowElement>('tbody tr')].find((r) =>
    r.textContent?.includes(name),
  )
  if (!found) throw new Error(`no row for ${name}`)
  return found
}

function folderButton(target: HTMLElement, label: string): HTMLButtonElement {
  const found = [...target.querySelectorAll<HTMLButtonElement>('button.fold')].find((b) =>
    b.textContent?.includes(label),
  )
  if (!found) throw new Error(`no folder button ${label}`)
  return found
}

describe('DatabasesTab (v1.23)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it('lists the own files with their kind; only the live file downloads, as a snapshot', async () => {
    vi.stubGlobal('fetch', stubFetch())
    const { target, cleanup } = renderMounted()
    await settled()

    const live = row(target, 'w-1-2026-10-14__09_00_00.db')
    expect(live.textContent).toContain('live')
    expect(live.textContent).toContain('12')
    expect(live.querySelector('a')?.getAttribute('href')).toBe(
      '/api/v1/debug/download-live?source=file',
    )
    expect(live.querySelector('input[type=checkbox]')).toBeNull()
    const backlog = row(target, 'w-1-2026-10-14__08_00_00.db')
    expect(backlog.textContent).toContain('backlog')
    expect(backlog.querySelector('a')).toBeNull()
    cleanup()
  })

  it('draws the memory row first with its title and a memory download link', async () => {
    const memory = {
      filename: 'w-1-memory',
      worker_name: 'w-1',
      cluster_name: 'search',
      kind: 'memory',
      event_count: 40,
      event_counts: { task_started: 20, task_completed: 20 },
      first_event_ts: 1760432400,
      last_event_ts: 1760432460,
      size_bytes: 65536,
    }
    vi.stubGlobal('fetch', stubFetch({ ...body, own: [memory, ...body.own] }))
    const { target, cleanup } = renderMounted()
    await settled()

    const rows = [...target.querySelectorAll<HTMLTableRowElement>('tbody tr')]
    expect(rows[0].textContent).toContain('w-1-memory')
    const chip = rows[0].querySelector('.chip.kind')
    expect(chip?.textContent).toBe('memory')
    expect(chip?.getAttribute('title')).toBe('Recent events in memory; not a file')
    expect(rows[0].querySelector('a')?.getAttribute('href')).toBe(
      '/api/v1/debug/download-live?source=memory',
    )
    cleanup()
  })

  it('draws an answer without a memory row exactly as before', async () => {
    vi.stubGlobal('fetch', stubFetch())
    const { target, cleanup } = renderMounted()
    await settled()

    expect(target.textContent).not.toContain('memory')
    const ownTable = target.querySelector('table')!
    const chips = [...ownTable.querySelectorAll('.chip.kind')].map((c) => c.textContent)
    expect(chips).toEqual(['live', 'backlog'])
    cleanup()
  })

  it('shows one foldable block per history folder, with statistics from the meta file', async () => {
    vi.stubGlobal('fetch', stubFetch())
    const { target, cleanup } = renderMounted()
    await settled()

    expect(folderButton(target, 'search').textContent).toContain('4')
    expect(folderButton(target, 'merged').textContent).toContain('1')
    const w1 = row(target, 'w-1-2026-10-14__07_00_00.db')
    expect(w1.textContent).toContain('w-1')
    expect(w1.textContent).toContain('7')
    expect(w1.querySelector('a')?.getAttribute('href')).toBe(
      '/api/v1/debug/download/history/search/w-1-2026-10-14__07_00_00.db',
    )
    // A sealed file without its meta file shows its size only.
    const w3 = row(target, 'w-3-2026-10-14__07_00_00.db')
    expect(w3.querySelector('td.events')?.textContent?.trim()).toBe('-')
    expect(w3.textContent).toContain('4.0 KB')
    cleanup()
  })

  it('downloads an archive by path but never offers it for a merge', async () => {
    vi.stubGlobal('fetch', stubFetch())
    localStorage.setItem('drakkar_token', 'tok')
    const { target, cleanup } = renderMounted()
    await settled()

    const archive = row(target, 'search-2026-10-12_00-00__2026-10-13_00-00.db.gz')
    expect(archive.querySelector('input[type=checkbox]')).toBeNull()
    expect(archive.querySelector('a')?.getAttribute('href')).toBe(
      '/api/v1/debug/download/history/search/search-2026-10-12_00-00__2026-10-13_00-00.db.gz?token=tok',
    )
    expect(archive.textContent).toContain('3.0 MB')
    cleanup()
  })

  it('folds and unfolds a history folder', async () => {
    vi.stubGlobal('fetch', stubFetch())
    const { target, cleanup } = renderMounted()
    await settled()

    folderButton(target, 'search').click()
    flushSync()
    expect(() => row(target, 'w-2-2026-10-14__07_00_00.db')).toThrow()
    folderButton(target, 'search').click()
    flushSync()
    expect(row(target, 'w-2-2026-10-14__07_00_00.db')).toBeTruthy()
    cleanup()
  })

  it('merges the selected history files by path and links the result', async () => {
    vi.stubGlobal('fetch', stubFetch())
    const { target, cleanup } = renderMounted()
    await settled()

    for (const name of [
      'w-1-2026-10-14__07_00_00.db',
      'merged-2026-10-14__10_00_00-0123456789abcdef.db',
    ]) {
      row(target, name).querySelector<HTMLInputElement>('input[type=checkbox]')!.click()
    }
    flushSync()
    const mergeButton = [...target.querySelectorAll('button')].find((b) =>
      b.textContent?.startsWith('Merge'),
    )!
    expect(mergeButton.textContent).toContain('(2)')
    mergeButton.click()
    await settled()

    expect(lastMergeBody).toEqual({
      filenames: [
        'history/search/w-1-2026-10-14__07_00_00.db',
        'merged/merged-2026-10-14__10_00_00-0123456789abcdef.db',
      ],
    })
    const banner = target.querySelector('.banner a')
    expect(banner?.getAttribute('href')).toBe(
      '/api/v1/debug/download/merged/merged-2026-10-14__11_00_00-fedcba9876543210.db',
    )
    cleanup()
  })

  it('filters history files by worker', async () => {
    vi.stubGlobal('fetch', stubFetch())
    const { target, cleanup } = renderMounted()
    await settled()

    const select = target.querySelector<HTMLSelectElement>('select')!
    select.value = 'w-2'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await settled()

    expect(row(target, 'w-2-2026-10-14__07_00_00.db')).toBeTruthy()
    expect(() => row(target, 'w-1-2026-10-14__07_00_00.db')).toThrow()
    cleanup()
  })

  it('merges only the selected files the worker filter shows', async () => {
    vi.stubGlobal('fetch', stubFetch())
    const { target, cleanup } = renderMounted()
    await settled()
    for (const name of ['w-1-2026-10-14__07_00_00.db', 'w-2-2026-10-14__07_00_00.db']) {
      row(target, name).querySelector<HTMLInputElement>('input[type=checkbox]')!.click()
    }
    flushSync()

    const select = target.querySelector<HTMLSelectElement>('select')!
    select.value = 'w-2'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await settled()

    const mergeButton = [...target.querySelectorAll('button')].find((b) =>
      b.textContent?.startsWith('Merge'),
    )!
    expect(mergeButton.textContent).toBe('Merge')
    expect(mergeButton.disabled).toBe(true)
    cleanup()
  })

  it('says the view is not available on a backend that answers the old array', async () => {
    vi.stubGlobal('fetch', stubFetch([{ filename: 'w.db' }]))
    const { target, cleanup } = renderMounted()
    await settled()

    expect(target.textContent).toContain('not available on this worker')
    expect(target.querySelectorAll('tbody tr')).toHaveLength(0)
    cleanup()
  })
})

// The cluster fan-out (v1.23 part 3): the own files of every same-cluster
// worker, each from that worker; the history from this worker only.
const peerOwn: DatabasesResponse = {
  own: [
    {
      filename: 'w-2-2026-10-14__09_00_00.db',
      worker_name: 'w-2',
      cluster_name: 'search',
      kind: 'live',
      event_count: 5,
      event_counts: { consumed: 5 },
      first_event_ts: 1760432400,
      last_event_ts: 1760432460,
      size_bytes: 4096,
    },
  ],
  history: { folders: [] },
}

const clusterWorkers = [
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
    online: true,
  },
]

function stubClusterFetch() {
  const urls: string[] = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    urls.push(url)
    if (url.endsWith('/api/v1/workers'))
      return new Response(JSON.stringify(clusterWorkers), { status: 200 })
    if (url.startsWith('http://w-3:8080/')) return new Response('{"error":"gone"}', { status: 404 })
    if (url.startsWith('http://w-2:8080/') && url.includes('/debug/databases')) {
      return new Response(JSON.stringify(peerOwn), { status: 200 })
    }
    if (url.includes('/debug/databases')) return new Response(JSON.stringify(body), { status: 200 })
    return new Response('[]', { status: 200 })
  })
  return { fetchMock, urls }
}

describe('DatabasesTab cluster fan-out (v1.23)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows the own files of every same-cluster worker, each with its live snapshot link', async () => {
    const { fetchMock, urls } = stubClusterFetch()
    vi.stubGlobal('fetch', fetchMock)
    const { target, cleanup } = renderMounted()
    await settled()

    expect(urls.filter((u) => u.includes('/debug/databases')).sort()).toEqual([
      '/api/v1/debug/databases',
      'http://w-2:8080/api/v1/debug/databases',
      'http://w-3:8080/api/v1/debug/databases',
    ])
    const headings = [...target.querySelectorAll('h2')].map((h) => h.textContent?.trim())
    expect(headings).toEqual(['Own files of w-1 (2)', 'Own files of w-2 (1)', 'History'])
    expect(
      row(target, 'w-2-2026-10-14__09_00_00.db').querySelector('a')?.getAttribute('href'),
    ).toBe('http://w-2:8080/api/v1/debug/download-live?source=file')
    expect(target.querySelector('.unreachable')?.textContent).toContain(
      'w-3 (not available on this worker)',
    )
    // The history comes from this worker alone.
    expect(folderButton(target, 'search').textContent).toContain('4')
    cleanup()
  })
})

describe('DatabasesTab with workers behind one address', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders a section per worker even when two workers share one URL', async () => {
    const shared = [
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
        url: 'http://lb:8080/',
        is_current: false,
        online: true,
      },
      {
        worker_name: 'w-3',
        cluster: 'search',
        url: 'http://lb:8080/',
        is_current: false,
        online: true,
      },
    ]
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.endsWith('/api/v1/workers'))
          return new Response(JSON.stringify(shared), { status: 200 })
        if (url.startsWith('http://lb:8080/'))
          return new Response(JSON.stringify(peerOwn), { status: 200 })
        if (url.includes('/debug/databases'))
          return new Response(JSON.stringify(body), { status: 200 })
        return new Response('[]', { status: 200 })
      }),
    )
    const { target, cleanup } = renderMounted()
    await settled()

    const headings = [...target.querySelectorAll('h2')].map((h) => h.textContent?.trim())
    expect(headings).toEqual([
      'Own files of w-1 (2)',
      'Own files of w-2 (1)',
      'Own files of w-3 (1)',
      'History',
    ])
    cleanup()
  })
})
