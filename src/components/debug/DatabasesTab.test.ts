// Databases tab (contract v1.23): this worker's own files and the shared
// history folders, rendered against a stubbed fetch. Covers the own table,
// one foldable block per history folder, meta-based statistics, downloads
// and merge by path, the worker filter, and the "not available" answer for
// a backend that predates v1.23.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import DatabasesTab from './DatabasesTab.svelte'
import { setQuery } from '../../lib/router'
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
    vi.stubGlobal('fetch', stubFetch({ ...body, own: [memory, ...(body.own ?? [])] }))
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

    const select = target.querySelector<HTMLSelectElement>('select[aria-label="worker filter"]')!
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

    const select = target.querySelector<HTMLSelectElement>('select[aria-label="worker filter"]')!
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
    setQuery('', { replace: true })
  })

  it('shows the own files of every same-cluster worker, each with its live snapshot link', async () => {
    setQuery('db_worker=*', { replace: true })
    const { fetchMock, urls } = stubClusterFetch()
    vi.stubGlobal('fetch', fetchMock)
    const { target, cleanup } = renderMounted()
    await settled()

    expect(urls.filter((u) => u.includes('/debug/databases')).sort()).toEqual([
      '/api/v1/debug/databases',
      'http://w-2:8080/api/v1/debug/databases?parts=own,storage,recorder',
      'http://w-3:8080/api/v1/debug/databases?parts=own,storage,recorder',
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
    setQuery('', { replace: true })
  })

  it('renders a section per worker even when two workers share one URL', async () => {
    setQuery('db_worker=*', { replace: true })
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

// Peers are read on an explicit choice only (design 2.4).
describe('DatabasesTab peer reads on demand', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    setQuery('', { replace: true })
    localStorage.clear()
  })

  const peerCalls = (urls: string[]) => urls.filter((u) => u.startsWith('http://'))

  function picker(target: HTMLElement): HTMLSelectElement {
    return target.querySelector<HTMLSelectElement>('select[aria-label="worker picker"]')!
  }

  it('calls no peer when the tab opens', async () => {
    const { fetchMock, urls } = stubClusterFetch()
    vi.stubGlobal('fetch', fetchMock)
    const { target, cleanup } = renderMounted()
    await settled()

    expect(peerCalls(urls)).toEqual([])
    expect(target.querySelectorAll('h2')[0].textContent).toContain('w-1')
    cleanup()
  })

  it('reads every peer only after the user picks All workers, and puts it in the URL', async () => {
    const { fetchMock, urls } = stubClusterFetch()
    vi.stubGlobal('fetch', fetchMock)
    const { target, cleanup } = renderMounted()
    await settled()
    const before = history.length

    const select = picker(target)
    select.value = '*'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await settled()

    expect(peerCalls(urls).sort()).toEqual([
      'http://w-2:8080/api/v1/debug/databases?parts=own,storage,recorder',
      'http://w-3:8080/api/v1/debug/databases?parts=own,storage,recorder',
    ])
    expect(window.location.search).toBe('?db_worker=*')
    expect(history.length).toBe(before + 1)
    cleanup()
  })

  it('reads only the named peer when one worker is picked, keeping the token in the URL', async () => {
    setQuery('token=abc', { replace: true })
    const { fetchMock, urls } = stubClusterFetch()
    vi.stubGlobal('fetch', fetchMock)
    const { target, cleanup } = renderMounted()
    await settled()

    const select = picker(target)
    select.value = 'w-2'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await settled()

    expect(peerCalls(urls)).toEqual([
      'http://w-2:8080/api/v1/debug/databases?parts=own,storage,recorder',
    ])
    expect(new URLSearchParams(window.location.search).get('token')).toBe('abc')
    expect(new URLSearchParams(window.location.search).get('db_worker')).toBe('w-2')
    cleanup()
  })

  it('never calls a peer with ui_enabled false, even for All workers', async () => {
    setQuery('db_worker=*', { replace: true })
    const urls: string[] = []
    const workers = clusterWorkers.map((w) =>
      w.worker_name === 'w-3' ? { ...w, ui_enabled: false } : w,
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        urls.push(url)
        if (url.endsWith('/api/v1/workers')) return new Response(JSON.stringify(workers))
        if (url.startsWith('http://w-2:8080/')) return new Response(JSON.stringify(peerOwn))
        return new Response(JSON.stringify(body))
      }),
    )
    const { cleanup } = renderMounted()
    await settled()

    expect(peerCalls(urls)).toHaveLength(1)
    expect(peerCalls(urls)[0]).toContain('http://w-2:8080/')
    cleanup()
  })

  it('rebuilds the view from a link: a pasted db_worker=w-2 reads that peer on open', async () => {
    setQuery('db_worker=w-2', { replace: true })
    const { fetchMock, urls } = stubClusterFetch()
    vi.stubGlobal('fetch', fetchMock)
    const { target, cleanup } = renderMounted()
    await settled()

    expect(peerCalls(urls)).toHaveLength(1)
    expect(picker(target).value).toBe('w-2')
    cleanup()
  })

  it('requests the workers list once on open', async () => {
    setQuery('db_worker=*', { replace: true })
    const { fetchMock, urls } = stubClusterFetch()
    vi.stubGlobal('fetch', fetchMock)
    const { cleanup } = renderMounted()
    await settled()

    expect(urls.filter((u) => u.endsWith('/api/v1/workers'))).toHaveLength(1)
    cleanup()
  })

  it('makes no new read when another db_ key changes', async () => {
    setQuery('db_worker=*', { replace: true })
    const { fetchMock, urls } = stubClusterFetch()
    vi.stubGlobal('fetch', fetchMock)
    const { cleanup } = renderMounted()
    await settled()
    const before = urls.length

    setQuery('db_worker=*&db_range=1h', { replace: true })
    await settled()

    expect(urls.length).toBe(before)
    cleanup()
  })

  it('undoes a worker pick with Back', async () => {
    const { fetchMock, urls } = stubClusterFetch()
    vi.stubGlobal('fetch', fetchMock)
    const { target, cleanup } = renderMounted()
    await settled()
    const select = picker(target)
    select.value = 'w-2'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await settled()
    expect(window.location.search).toBe('?db_worker=w-2')

    window.history.back()
    await new Promise((resolve) => setTimeout(resolve, 50))
    await settled()

    expect(window.location.search).toBe('')
    expect(picker(target).value).toBe('')
    expect(peerCalls(urls)).toHaveLength(1)
    cleanup()
  })
})

// Contract v1.30 (first part): the mode strip, the own folder with the cache
// snapshot, the other worker folders of the host, the history cleanup line and
// the compressed downloads. Each panel draws only when its key is present.
const v130: DatabasesResponse = {
  ...body,
  worker: { name: 'w-1', cluster: 'search', instance: '0123456789abcdef' },
  recorder: {
    enabled: true,
    provider: 'sqlite',
    memory: { window_seconds: 120, max_rows: 12000, max_bytes: 268435456 },
    sqlite: {
      rotation_interval_seconds: 3600,
      archive: {
        enabled: true,
        scope: 'worker',
        next_slot_ts: null,
        window_seconds: 86400,
        due_after_seconds: 172800,
        retention_days: 30,
        merged_retention_days: 7,
      },
    },
    postgres: null,
  },
  storage: {
    dir_set: true,
    own_folder: 'search/w-1',
    shared_dir_set: false,
    shared_is_storage_dir: true,
    files: [
      {
        name: '.owner.lock',
        kind: 'owner_lock',
        size_bytes: 0,
        modified_at: '2026-10-14T08:00:00.000000Z',
        entries: null,
      },
      {
        name: 'w-1-cache.db',
        kind: 'cache',
        size_bytes: 40960,
        modified_at: '2026-10-14T09:00:00.000000Z',
        entries: 1234,
      },
    ],
    temp_files: { count: 2, size_bytes: 4096 },
    siblings: [
      {
        worker: 'w-old',
        files: 3,
        size_bytes: 8192,
        newest_modified_at: '2026-10-13T09:00:00.000000Z',
        in_use: false,
        online: false,
      },
    ],
  },
}

describe('DatabasesTab v1.30 panels', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it('shows the mode strip of the serving worker', async () => {
    vi.stubGlobal('fetch', stubFetch(v130))
    const { target, cleanup } = renderMounted()
    await settled()

    const strip = target.querySelector('[data-testid=mode-strip]')
    expect(strip?.textContent).toBe(
      'w-1 · cluster search · recorder sqlite (memory 2m, rotation 1h) · archive: worker scope',
    )
    cleanup()
  })

  it('lists the own folder files with the cache snapshot links and the temp file count', async () => {
    vi.stubGlobal('fetch', stubFetch(v130))
    const { target, cleanup } = renderMounted()
    await settled()

    expect(target.textContent).toContain('Own folder search/w-1')
    const cache = row(target, 'w-1-cache.db')
    expect(cache.textContent).toContain('1,234')
    expect([...cache.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual([
      '/api/v1/debug/download-live?source=cache',
      '/api/v1/debug/download-live?source=cache&compress=gzip',
    ])
    expect(row(target, '.owner.lock').querySelector('a')).toBeNull()
    expect(target.textContent).toContain('Download temp files: 2')
    cleanup()
  })

  it('lists the other worker folders of the host with their lock and registry state', async () => {
    vi.stubGlobal('fetch', stubFetch(v130))
    const { target, cleanup } = renderMounted()
    await settled()

    expect(target.textContent).toContain('Other folders on this host (1)')
    const sibling = row(target, 'w-old')
    expect(sibling.textContent).toContain('free')
    expect(sibling.textContent).toContain('offline')
    cleanup()
  })

  it('offers compressed downloads for snapshots and history files, never for an archive', async () => {
    vi.stubGlobal('fetch', stubFetch(v130))
    const { target, cleanup } = renderMounted()
    await settled()

    const live = row(target, 'w-1-2026-10-14__09_00_00.db')
    expect(live.querySelector('a.gz')?.getAttribute('href')).toBe(
      '/api/v1/debug/download-live?source=file&compress=gzip',
    )
    const sealedRow = row(target, 'w-1-2026-10-14__07_00_00.db')
    expect(sealedRow.querySelector('a.gz')?.getAttribute('href')).toBe(
      '/api/v1/debug/download/history/search/w-1-2026-10-14__07_00_00.db?compress=gzip',
    )
    expect(
      row(target, 'search-2026-10-12_00-00__2026-10-13_00-00.db.gz').querySelector('a.gz'),
    ).toBeNull()
    cleanup()
  })

  it('says when history files leave', async () => {
    vi.stubGlobal('fetch', stubFetch(v130))
    const { target, cleanup } = renderMounted()
    await settled()

    expect(target.querySelector('.cleanup')?.textContent).toBe(
      'Sealed files go into an archive 48h after their 24h window ends; archives are deleted after 30 days; ' +
        'merge results are deleted after 7 days.',
    )
    cleanup()
  })

  it('says a worker with no storage.dir has no own folder', async () => {
    const noFolder = {
      ...v130,
      storage: { ...v130.storage!, dir_set: false, own_folder: '', files: [], siblings: null },
    }
    vi.stubGlobal('fetch', stubFetch(noFolder))
    const { target, cleanup } = renderMounted()
    await settled()

    expect(target.textContent).toContain('No own folder')
    expect(target.textContent).not.toContain('Other folders on this host')
    cleanup()
  })

  it('hides every v1.30 panel for an answer older than v1.30', async () => {
    vi.stubGlobal('fetch', stubFetch(body))
    const { target, cleanup } = renderMounted()
    await settled()

    expect(target.querySelector('[data-testid=mode-strip]')).toBeNull()
    expect(target.textContent).not.toContain('Own folder')
    expect(target.textContent).not.toContain('Other folders on this host')
    expect(target.querySelector('.cleanup')).toBeNull()
    expect(target.querySelector('a.gz')).toBeNull()
    cleanup()
  })
})

// v1.30, third part: the Postgres view, the Autodiscover view and the delete
// of a merge result. Each route is stubbed by its path; the Postgres route is
// matched before /debug/databases, whose prefix it shares.
const postgresBody: DatabasesResponse = {
  ...v130,
  recorder: {
    enabled: true,
    provider: 'postgres',
    memory: null,
    sqlite: null,
    postgres: {
      connection: 'main',
      schema: 'drakkar',
      table: 'fast_recorder_events',
      initial_retention_hours: 6,
      max_size_bytes: 64 * 1024 * 1024,
      store_completed_output: false,
      writer: {
        started: true,
        queue_rows: 3,
        queue_bytes: 300,
        rows_written: 1200,
        dropped: { queue_full: 0, rejected: 2, no_partition: 0, shutdown: 0 },
        breaker_open: false,
        last_upkeep: null,
      },
    },
  },
}

const MIB = 1024 * 1024
const partitionsBody = {
  server_now: 1762596100,
  stored_retention_hours: 24,
  partitions: [
    {
      name: 'fast_recorder_events_p2026110807',
      from_ts: 1762585200,
      to_ts: 1762588800,
      size_bytes: 40 * MIB,
    },
    {
      name: 'fast_recorder_events_p2026110808',
      from_ts: 1762588800,
      to_ts: 1762592400,
      size_bytes: 30 * MIB,
    },
    {
      name: 'fast_recorder_events_p2026110809',
      from_ts: 1762592400,
      to_ts: 1762596000,
      size_bytes: null,
    },
  ],
  total_bytes: 70 * MIB,
  next_drops: { retention: [], size: ['fast_recorder_events_p2026110807'] },
}

const autodiscoverBody = {
  registry: {
    provider: 'redis',
    connection: 'main',
    started: true,
    refreshed_at: '2026-11-08T10:00:00.000000Z',
    last_publish_at: '2026-11-08T10:00:02.000000Z',
    breaker_open: false,
    offline_after_seconds: 60,
  },
  worker: {
    name: 'w-1',
    cluster: 'search',
    instance: '0123456789abcdef',
    key: 'drakkar:fleet:workers:w-1',
  },
  workers: [
    {
      worker: 'w-2',
      instance: 'fedcba9876543210',
      cluster: 'search',
      state: 'running',
      backend: 'python',
      version: '2.5.0',
      url: 'http://w-2:8080/',
      started_at: null,
      heartbeat_at: null,
      age_seconds: 2.4,
      online: true,
      key: 'drakkar:fleet:workers:w-2',
      features: {},
    },
    {
      worker: 'w-9',
      instance: 'aaaaaaaaaaaaaaaa',
      cluster: 'other',
      state: 'running',
      backend: 'python',
      version: '2.5.0',
      url: 'javascript:alert(1)',
      started_at: null,
      heartbeat_at: null,
      age_seconds: 99,
      online: false,
      key: 'drakkar:fleet:workers:w-9',
      features: {},
    },
  ],
  truncated: false,
}

const leasesBody = {
  election: { provider: 'redis', started: true, breaker_open: false },
  leases: [
    {
      task: 'history.archive',
      scope: 'search/history.archive',
      system: true,
      lease_seconds: 60,
      next_slot_ts: 1762599600,
      last_slot: { slot: 1762596000, outcome: 'held_elsewhere', at: '2026-11-08T10:00:00.004000Z' },
      status: 'held',
      holder: {
        worker: 'w-2',
        instance: 'fedcba9876543210',
        acquired_at: '2026-11-08T10:00:00.010000Z',
        age_seconds: null,
        expires_in_seconds: 41.5,
      },
      key: 'drakkar:task-locks:search/history.archive',
    },
  ],
}

interface ThirdPartStub {
  databases?: unknown
  partitions?: unknown
  partitionsStatus?: number
  autodiscoverStatus?: number
  deleteStatus?: number
}

function stubThirdPart(options: ThirdPartStub = {}) {
  const calls: { method: string; url: string }[] = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls.push({ method, url })
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
    if (url.includes('/debug/databases/postgres')) {
      return options.partitionsStatus
        ? json({ error: 'postgres read failed' }, options.partitionsStatus)
        : json(options.partitions ?? partitionsBody)
    }
    if (url.includes('/debug/files/')) {
      const status = options.deleteStatus ?? 204
      return status === 204
        ? new Response(null, { status })
        : json({ error: 'the file is in use on this worker' }, status)
    }
    if (url.includes('/debug/autodiscover/leases')) return json(leasesBody)
    if (url.includes('/debug/autodiscover')) {
      return options.autodiscoverStatus
        ? json({ error: 'autodiscover is off' }, options.autodiscoverStatus)
        : json(autodiscoverBody)
    }
    if (url.includes('/debug/databases')) return json(options.databases ?? v130)
    return json([])
  })
  return { fetchMock, calls }
}

function viewButtons(target: HTMLElement): string[] {
  const group = target.querySelector('[aria-label="database views"]')!
  return [...group.querySelectorAll('button')].map((b) => b.textContent ?? '')
}

describe('DatabasesTab v1.30 third part', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    setQuery('', { replace: true })
    localStorage.clear()
  })

  it('offers the Postgres view only for a worker whose recorder writes to Postgres', async () => {
    const sqlite = stubThirdPart()
    vi.stubGlobal('fetch', sqlite.fetchMock)
    const first = renderMounted()
    await settled()
    expect(viewButtons(first.target)).toEqual(['Files', 'Slice', 'Autodiscover'])
    first.cleanup()

    vi.stubGlobal('fetch', stubThirdPart({ databases: postgresBody }).fetchMock)
    const second = renderMounted()
    await settled()
    expect(viewButtons(second.target)).toEqual(['Files', 'Postgres', 'Slice', 'Autodiscover'])
    second.cleanup()
  })

  it('draws the table, the writer and the partitions with the drops of the next upkeep', async () => {
    setQuery('db_view=postgres', { replace: true })
    const { fetchMock, calls } = stubThirdPart({ databases: postgresBody })
    vi.stubGlobal('fetch', fetchMock)
    const { target, cleanup } = renderMounted()
    await settled()

    expect(target.querySelector('[data-testid=pg-table]')?.textContent).toBe(
      'drakkar.fast_recorder_events',
    )
    expect(target.querySelector('[data-testid=pg-writer]')?.textContent).toBe(
      '1,200 rows written · 3 waiting (300 B) · 2 dropped',
    )
    expect(target.textContent).toContain('Dropped by reason: rejected: 2')
    expect(target.querySelector('[data-testid=pg-retention]')?.textContent?.trim()).toBe(
      "The upkeep keeps 24h of history (stored in the table). This worker's initial_retention is 6h; it applies only to a new table.",
    )
    expect(target.querySelector('[data-testid=pg-size]')?.textContent).toBe(
      'Total 70.0 MB of a cap of 64.0 MB.',
    )
    expect(row(target, 'fast_recorder_events_p2026110807').textContent).toContain('drops (size)')
    expect(row(target, 'fast_recorder_events_p2026110808').textContent).toContain('keeps')
    expect(row(target, 'fast_recorder_events_p2026110809').textContent).toContain('-')
    expect(calls.filter((c) => c.url.includes('/debug/databases/postgres'))).toHaveLength(1)
    cleanup()
  })

  it('says the partitions are not available when the worker answers 404, and shows a 503', async () => {
    setQuery('db_view=postgres', { replace: true })
    vi.stubGlobal(
      'fetch',
      stubThirdPart({ databases: postgresBody, partitionsStatus: 404 }).fetchMock,
    )
    const missing = renderMounted()
    await settled()
    expect(missing.target.textContent).toContain('The partitions are not available on this worker.')
    missing.cleanup()

    vi.stubGlobal(
      'fetch',
      stubThirdPart({ databases: postgresBody, partitionsStatus: 503 }).fetchMock,
    )
    const failed = renderMounted()
    await settled()
    expect(failed.target.querySelector('.error')?.textContent).toContain('postgres read failed')
    failed.cleanup()
  })

  it('falls back to the Files view for a pasted Postgres link on a worker without Postgres', async () => {
    setQuery('db_view=postgres', { replace: true })
    const { fetchMock, calls } = stubThirdPart()
    vi.stubGlobal('fetch', fetchMock)
    const { target, cleanup } = renderMounted()
    await settled()

    expect(target.querySelector('[aria-pressed=true]')?.textContent).toBe('Files')
    expect(
      calls.filter((c) => c.url.includes('/debug/databases/postgres')).map((c) => c.url),
    ).toEqual([])
    cleanup()
  })

  it('draws the registry, the cards by cluster and the lease holders', async () => {
    setQuery('db_view=autodiscover', { replace: true })
    vi.stubGlobal('fetch', stubThirdPart().fetchMock)
    const { target, cleanup } = renderMounted()
    await settled()

    expect(target.querySelector('[data-testid=registry-line]')?.textContent).toContain(
      'redis (connection main) · started',
    )
    expect([...target.querySelectorAll('h3')].map((h) => h.textContent)).toEqual([
      'Cluster search',
      'Cluster other',
    ])
    const peer = row(target, 'fedcba9876543210')
    expect(peer.querySelector('a')?.getAttribute('href')).toBe('http://w-2:8080')
    expect(peer.textContent).toContain('online')
    expect(peer.textContent).toContain('drakkar:fleet:workers:w-2')
    // A card URL that is not http(s) is never a link.
    expect(row(target, 'aaaaaaaaaaaaaaaa').querySelector('a')).toBeNull()
    const lease = row(target, 'history.archive')
    expect(lease.textContent).toContain('held by w-2 (fedcba9876543210)')
    expect(lease.textContent).toContain('42s')
    expect(lease.textContent).toContain('drakkar:task-locks:search/history.archive')
    cleanup()
  })

  it('says the registry is not available when the worker answers 404', async () => {
    setQuery('db_view=autodiscover', { replace: true })
    vi.stubGlobal('fetch', stubThirdPart({ autodiscoverStatus: 404 }).fetchMock)
    const { target, cleanup } = renderMounted()
    await settled()

    expect(target.textContent).toContain('The registry is not available on this worker.')
    expect(row(target, 'history.archive')).toBeTruthy()
    cleanup()
  })

  const MERGED = 'merged-2026-10-14__10_00_00-0123456789abcdef.db'
  const withDelete = {
    ...v130,
    history: { ...v130.history!, delete_enabled: true },
  }

  function deleteButton(target: HTMLElement): HTMLButtonElement | null {
    return row(target, MERGED).querySelector<HTMLButtonElement>('button.delete')
  }

  it('offers no delete while the worker does not say it is on', async () => {
    vi.stubGlobal('fetch', stubThirdPart().fetchMock)
    const { target, cleanup } = renderMounted()
    await settled()

    expect(deleteButton(target)).toBeNull()
    cleanup()
  })

  it('offers the delete on merge results only, and sends nothing when the confirm is refused', async () => {
    const { fetchMock, calls } = stubThirdPart({ databases: withDelete })
    vi.stubGlobal('fetch', fetchMock)
    const confirm = vi.fn(() => false)
    vi.stubGlobal('confirm', confirm)
    const { target, cleanup } = renderMounted()
    await settled()

    expect(row(target, 'w-1-2026-10-14__07_00_00.db').querySelector('button.delete')).toBeNull()
    deleteButton(target)!.click()
    await settled()

    expect(confirm).toHaveBeenCalledWith(
      `Delete the merge result ${MERGED}? The sealed files and archives it was made from stay.`,
    )
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    cleanup()
  })

  it('deletes a confirmed merge result by path and reads the databases again', async () => {
    const { fetchMock, calls } = stubThirdPart({ databases: withDelete })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    )
    const { target, cleanup } = renderMounted()
    await settled()
    const readsBefore = calls.filter((c) => c.url.includes('/debug/databases')).length

    deleteButton(target)!.click()
    await settled()

    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual([
      `/api/v1/debug/files/merged/${MERGED}`,
    ])
    expect(calls.filter((c) => c.url.includes('/debug/databases')).length).toBe(readsBefore + 1)
    expect(target.querySelector('.error')).toBeNull()
    cleanup()
  })

  it('shows the answer of a refused delete', async () => {
    vi.stubGlobal('fetch', stubThirdPart({ databases: withDelete, deleteStatus: 409 }).fetchMock)
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    )
    const { target, cleanup } = renderMounted()
    await settled()

    deleteButton(target)!.click()
    await settled()

    expect(target.querySelector('.error')?.textContent).toContain(
      'the file is in use on this worker',
    )
    cleanup()
  })
})
